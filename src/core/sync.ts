// The sync engine: scan the vault, commit local changes, fetch from every host,
// merge, update the vault, and bring every host up to the merged commit.

import { contentHash, decryptObject, encryptObject, Entry, fileId, Manifest, normalizePath } from "./format";
import { FilterOptions, isExcluded } from "./filter";
import { changePassword, KeyFile, serializeKeyFile, VaultKeys, WrongPasswordError } from "./keys";
import type { Argon2Params } from "./crypto";
import { Conflict, merge3 } from "./merge";
import { clashKey, conflictName, safePath, uniqueName } from "./names";
import { Repo } from "./repo";
import { AuthError, Endpoint, PushRejectedError, Transport } from "./transport";

export interface VaultFileInfo {
  path: string;
  size: number;
  mtime: number;
}

/** Access to the plaintext vault on this device. */
export interface VaultIO {
  /** Every file in the vault, including hidden folders. */
  list(): Promise<VaultFileInfo[]>;
  stat(path: string): Promise<{ size: number; mtime: number } | null>;
  read(path: string): Promise<Uint8Array>;
  /** Create or replace a file, creating parent folders. */
  write(path: string, data: Uint8Array, mtime: number): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export interface FileState {
  s: number;
  t: number;
  h: string;
}

/** Per-device state kept outside the vault and the repo. */
export interface LocalState {
  vaultId?: string;
  files: Record<string, FileState>;
  lastSync?: number;
}

export interface StateStore {
  load(): Promise<LocalState>;
  save(s: LocalState): Promise<void>;
}

export interface KeyProvider {
  /** Unlock an existing vault (may ask for the password). */
  unlock(kf: KeyFile): Promise<VaultKeys>;
  /** Set up a new vault (asks for a new password). */
  create(): Promise<{ keyFile: KeyFile; keys: VaultKeys }>;
}

export interface SyncOptions extends FilterOptions {
  device: string;
}

export type RemoteProblem = "auth" | "mismatch" | "network" | "rejected" | "other";

export interface RemoteStatus {
  id: string;
  name: string;
  url: string;
  reachable: boolean;
  pushed: boolean;
  upToDate: boolean;
  error?: string;
  problem?: RemoteProblem;
}

export interface SyncReport {
  head: string | null;
  committedLocal: boolean;
  /** Files written to or removed from the vault. */
  applied: number;
  conflicts: Conflict[];
  /** Files saved as conflict copies because they changed while syncing. */
  lateConflicts: Conflict[];
  clashes: { from: string; to: string }[];
  renamedLocal: { from: string; to: string }[];
  remotes: RemoteStatus[];
}

export class VaultMismatchError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "VaultMismatchError";
  }
}

export interface SyncDeps {
  repo: Repo;
  vault: VaultIO;
  state: StateStore;
  keys: KeyProvider;
  transportFor: (ep: Endpoint) => Transport;
  endpoints: () => Endpoint[];
  options: () => SyncOptions;
  now?: () => Date;
}

const MAX_PUSH_ROUNDS = 4;

export class SyncEngine {
  private running: Promise<SyncReport> | null = null;

  constructor(private readonly d: SyncDeps) {}

  get isRunning(): boolean {
    return this.running !== null;
  }

  /** Run a sync. A call while one is running returns the running one. */
  sync(): Promise<SyncReport> {
    if (!this.running) {
      this.running = this.run().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  /**
   * Re-wrap the vault key with a new password, commit, and sync it to every host.
   * File contents are not re-encrypted.
   */
  async changePassword(newPassword: string, params?: Argon2Params): Promise<SyncReport> {
    while (this.running) await this.running.catch(() => {});
    const p = (async () => {
      const { repo } = this.d;
      await repo.init();
      const head = await repo.head();
      const id = head ? await repo.keyFileAt(head) : null;
      if (!head || !id) throw new Error("Sync at least once before changing the password");
      const keys = await this.d.keys.unlock(id.keyFile);
      const kf = await changePassword(id.keyFile, keys, newPassword, params);
      const kfOid = await repo.writeBlob(serializeKeyFile(kf));
      const m = await repo.manifestAt(keys, head);
      await repo.setHead(await repo.writeState(keys, m, kfOid, [head], this.d.now?.() ?? new Date()));
      return this.run();
    })();
    this.running = p.finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(): Promise<SyncReport> {
    const { repo } = this.d;
    const opt = this.d.options();
    const now = this.d.now?.() ?? new Date();
    await repo.init();

    const eps = this.d.endpoints();
    const status = new Map<string, RemoteStatus>(
      eps.map((ep) => [ep.id, { id: ep.id, name: ep.name, url: ep.url, reachable: false, pushed: false, upToDate: false }]),
    );
    /** Hosts we may push to, with their current head (null = empty). */
    const heads = new Map<string, string | null>();

    const fail = (ep: Endpoint, e: unknown) => {
      const st = status.get(ep.id)!;
      st.error = e instanceof Error ? e.message : String(e);
      st.problem =
        e instanceof AuthError ? "auth" : e instanceof VaultMismatchError ? "mismatch" : e instanceof PushRejectedError ? "rejected" : "network";
      heads.delete(ep.id);
    };

    let local = await repo.head();
    let identity = local ? await repo.keyFileAt(local) : null;

    const fetchOne = async (ep: Endpoint) => {
      try {
        const h = await this.d.transportFor(ep).fetch(ep);
        status.get(ep.id)!.reachable = true;
        if (h) {
          const kf = await repo.keyFileAt(h).catch((e) => {
            throw new VaultMismatchError(`Not an encgidian vault: ${e.message}`);
          });
          if (!kf) throw new VaultMismatchError("This repository has other content and is not an encgidian vault");
          if (identity && kf.keyFile.vaultId !== identity.keyFile.vaultId) {
            throw new VaultMismatchError("This repository holds a different vault; it was left untouched");
          }
          identity ??= kf;
        }
        heads.set(ep.id, h);
      } catch (e) {
        fail(ep, e);
      }
    };
    // Fetch in order so the first host decides which vault a new device joins.
    if (!identity) for (const ep of eps) await fetchOne(ep);
    else await Promise.all(eps.map(fetchOne));

    // Unlock or create the vault key.
    let keys: VaultKeys;
    let keyFileOid: string;
    const isNewVault = !identity;
    if (!identity) {
      if (eps.length === 0) throw new Error("Add at least one Git host in the settings first");
      const unreachable = eps.filter((ep) => !status.get(ep.id)!.reachable);
      if (unreachable.length) {
        throw new Error(
          `Can't set up a new vault while ${unreachable.map((e) => e.name).join(", ")} can't be reached ` +
            `(it may already hold this vault). ${unreachable.map((e) => status.get(e.id)!.error).join("; ")}`,
        );
      }
      const created = await this.d.keys.create();
      keys = created.keys;
      keyFileOid = await repo.writeBlob(serializeKeyFile(created.keyFile));
    } else {
      keys = await this.d.keys.unlock(identity.keyFile);
      if (keys.vaultId !== identity.keyFile.vaultId) throw new WrongPasswordError("Unlocked the wrong vault");
      keyFileOid = identity.oid;
    }

    const state = await this.d.state.load();
    if (state.vaultId !== keys.vaultId) {
      state.vaultId = keys.vaultId;
      state.files = {};
    }

    // 1. Commit what changed in the vault since the last sync.
    const headM = await repo.manifestAt(keys, local);
    const scan = await this.scan(keys, headM, state, opt);
    let cur: string | null = local;
    let curM: Manifest = scan.manifest;
    const committedLocal = scan.changed || isNewVault;
    if (committedLocal) {
      cur = await repo.writeState(keys, scan.manifest, keyFileOid, local ? [local] : [], now);
    }

    // 2. Merge every host's head into ours.
    const conflicts: Conflict[] = [];
    const clashes: { from: string; to: string }[] = [];
    const mergeHeads = async () => {
      for (const ep of eps) {
        const r = heads.get(ep.id);
        if (!r) continue;
        if (!cur) {
          cur = r;
          curM = await repo.manifestAt(keys, r);
          continue;
        }
        if (await repo.isAncestor(r, cur)) continue;
        if (await repo.isAncestor(cur, r)) {
          cur = r;
          curM = await repo.manifestAt(keys, r);
          continue;
        }
        const mb = await repo.mergeBase(cur, r);
        const baseM = await repo.manifestAt(keys, mb);
        const theirsM = await repo.manifestAt(keys, r);
        const m = merge3(baseM, curM, theirsM, { device: opt.device, now });
        const merged = await this.materialize(keys, m.result);
        const kf = await this.mergeKeyFile(mb, cur, r);
        cur = await repo.writeState(keys, merged, kf, [cur, r], now);
        curM = merged;
        conflicts.push(...m.conflicts);
        clashes.push(...m.clashes);
      }
    };
    await mergeHeads();

    // 3. Bring the vault in line with the merged state.
    let vaultM = scan.manifest;
    const lateConflicts: Conflict[] = [];
    let applied = 0;
    const applyAndSetHead = async () => {
      applied += await this.apply(keys, vaultM, curM, state, opt, now, lateConflicts);
      vaultM = curM;
      if (cur) await repo.setHead(cur);
      state.lastSync = Date.now();
      await this.d.state.save(state);
    };
    await applyAndSetHead();

    // 4. Push to every host that is behind; on rejection fetch, merge and try again.
    for (let round = 0; cur && round < MAX_PUSH_ROUNDS; round++) {
      const target: string = cur;
      const rejected: Endpoint[] = [];
      await Promise.all(
        eps
          .filter((ep) => heads.has(ep.id))
          .map(async (ep) => {
            const st = status.get(ep.id)!;
            if (heads.get(ep.id) === target) {
              st.upToDate = true;
              return;
            }
            try {
              await this.d.transportFor(ep).push(ep, target);
              heads.set(ep.id, target);
              st.pushed = true;
              st.upToDate = true;
            } catch (e) {
              if (e instanceof PushRejectedError && round < MAX_PUSH_ROUNDS - 1) rejected.push(ep);
              else fail(ep, e);
            }
          }),
      );
      if (!rejected.length) break;
      for (const ep of rejected) status.get(ep.id)!.upToDate = false;
      await Promise.all(rejected.map(fetchOne));
      await mergeHeads();
      await applyAndSetHead();
      for (const ep of eps) if (heads.get(ep.id) !== cur) status.get(ep.id)!.upToDate = false;
    }

    return {
      head: cur,
      committedLocal,
      applied,
      conflicts,
      lateConflicts,
      clashes,
      renamedLocal: scan.renamed,
      remotes: [...status.values()],
    };
  }

  /** Read the vault and build its manifest, reusing unchanged entries. */
  private async scan(keys: VaultKeys, headM: Manifest, state: LocalState, opt: SyncOptions) {
    const { vault, repo } = this.d;
    let files = await vault.list();

    // Names that can't exist on Windows/Android, or that clash by case, are renamed on disk.
    const renamed: { from: string; to: string }[] = [];
    const allKeys = new Set(files.map((f) => clashKey(f.path)));
    const kept = new Set<string>();
    const ordered = [...files].sort((a, b) => Number(!headM.has(a.path)) - Number(!headM.has(b.path)) || (a.path < b.path ? -1 : 1));
    const out: VaultFileInfo[] = [];
    for (const f of ordered) {
      let p = f.path;
      try {
        p = normalizePath(p);
      } catch {
        continue;
      }
      if (isExcluded(p, f.size, opt)) {
        out.push({ ...f, path: p });
        continue;
      }
      let target = safePath(p);
      if (target !== f.path || kept.has(clashKey(target))) {
        target = uniqueName(target, new Set([...allKeys, ...kept]));
        await vault.rename(f.path, target);
        renamed.push({ from: f.path, to: target });
        allKeys.add(clashKey(target));
        const st = await vault.stat(target);
        if (st) f.mtime = st.mtime;
      }
      kept.add(clashKey(target));
      out.push({ ...f, path: target });
    }
    files = out;

    const manifest: Manifest = new Map();
    // Files this device doesn't sync (ignored, too big, config) stay as they are in the repo.
    for (const [p, e] of headM) if (isExcluded(p, e.s, opt)) manifest.set(p, e);

    let changed = false;
    const seen = new Set<string>();
    for (const f of files) {
      if (isExcluded(f.path, f.size, opt)) continue;
      seen.add(f.path);
      const he = headM.get(f.path);
      const cached = state.files[f.path];
      if (he && cached && cached.s === f.size && cached.t === f.mtime && cached.h === he.h) {
        manifest.set(f.path, he);
        continue;
      }
      const data = await vault.read(f.path);
      const h = await contentHash(keys, data);
      state.files[f.path] = { s: f.size, t: f.mtime, h };
      if (he && he.h === h) {
        manifest.set(f.path, he);
        continue;
      }
      const id = await fileId(keys, f.path);
      const o = await repo.writeBlob(await encryptObject(keys, f.path, id, data));
      manifest.set(f.path, { p: f.path, i: id, s: data.length, t: f.mtime, h, d: opt.device, o });
      changed = true;
    }
    for (const p of Object.keys(state.files)) if (!seen.has(p)) delete state.files[p];
    for (const p of headM.keys()) if (!manifest.has(p)) changed = true;
    return { manifest, changed, renamed };
  }

  /** Re-encrypt entries that moved to a new path (conflict copies, renames, clashes). */
  private async materialize(keys: VaultKeys, result: Map<string, Entry>): Promise<Manifest> {
    const out: Manifest = new Map();
    for (const [path, e] of result) {
      if (e.p === path) {
        out.set(path, e);
        continue;
      }
      const data = await decryptObject(keys, e.p, e.i, await this.d.repo.readBlob(e.o));
      const id = await fileId(keys, path);
      const o = await this.d.repo.writeBlob(await encryptObject(keys, path, id, data));
      out.set(path, { ...e, p: path, i: id, o });
    }
    return out;
  }

  private async mergeKeyFile(base: string | null, ours: string, theirs: string): Promise<string> {
    const b = base ? await this.d.repo.keyFileOid(base) : null;
    const o = await this.d.repo.keyFileOid(ours);
    const t = await this.d.repo.keyFileOid(theirs);
    if (!o) return t!;
    if (!t || t === b) return o;
    return t;
  }

  /** Does the file on disk still hold `hash`? (null when missing) */
  private async diskMatches(keys: VaultKeys, path: string, hash: string, state: LocalState): Promise<boolean | null> {
    const st = await this.d.vault.stat(path);
    if (!st) return null;
    const c = state.files[path];
    if (c && c.s === st.size && c.t === st.mtime) return c.h === hash;
    const h = await contentHash(keys, await this.d.vault.read(path));
    state.files[path] = { s: st.size, t: st.mtime, h };
    return h === hash;
  }

  /** Change the vault from `from` to `to`. Never overwrites content it hasn't seen. */
  private async apply(
    keys: VaultKeys,
    from: Manifest,
    to: Manifest,
    state: LocalState,
    opt: SyncOptions,
    now: Date,
    late: Conflict[],
  ): Promise<number> {
    const { vault, repo } = this.d;
    let n = 0;
    for (const [p, e] of from) {
      if (to.has(p) || isExcluded(p, e.s, opt)) continue;
      const m = await this.diskMatches(keys, p, e.h, state);
      if (m === true) {
        await vault.remove(p);
        // A delete that silently didn't happen would bring the file back on every
        // device at the next sync, so stop here instead (nothing is lost).
        if (await vault.stat(p)) throw new Error(`Couldn't delete "${p}" on this device; the sync was stopped so it isn't restored everywhere. Check its permissions or the trash setting.`);
        delete state.files[p];
        n++;
      }
      // m === false: edited during the sync; the next sync keeps that edit.
    }
    const taken = new Set([...from.keys(), ...to.keys()].map(clashKey));
    for (const [p, e] of [...to].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const prev = from.get(p);
      if (prev && prev.h === e.h) continue;
      if (isExcluded(p, e.s, opt)) continue;
      let target = p;
      const asConflict = () => {
        target = uniqueName(conflictName(p, opt.device, now), taken);
        taken.add(clashKey(target));
        late.push({ path: p, copy: target, kind: "both-edited" });
      };
      const checked = await vault.stat(p);
      if (checked) {
        const expected = prev ? await this.diskMatches(keys, p, prev.h, state) : false;
        if (!expected) {
          // The file on disk isn't the version we last saw (edited during the sync,
          // or a file this device doesn't sync). Keep it, save the incoming one beside it.
          if (await this.diskMatches(keys, p, e.h, state)) continue;
          asConflict();
        }
      }
      const data = await decryptObject(keys, e.p, e.i, await repo.readBlob(e.o));
      if (target === p) {
        // Last look right before writing, to keep the window for a lost edit tiny.
        const again = await vault.stat(p);
        if ((checked === null) !== (again === null) || (checked && again && (checked.size !== again.size || checked.mtime !== again.mtime))) {
          asConflict();
        }
      }
      await vault.write(target, data, e.t);
      if (target === p) {
        const st = await vault.stat(p);
        if (st) state.files[p] = { s: st.size, t: st.mtime, h: e.h };
      }
      n++;
    }
    return n;
  }
}
