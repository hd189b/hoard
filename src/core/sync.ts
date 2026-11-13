// The sync engine: scan the vault, commit local changes, fetch from every host,
// merge, update the vault, and bring every host up to the merged commit.

import { bytesEqual } from "./bytes";
import {
  contentHash,
  decryptObject,
  encryptObject,
  Entry,
  fileId,
  LARGE_OBJECT_BYTES,
  LARGE_PREFIX,
  Manifest,
  normalizePath,
  STEP_BYTES,
  STEP_PREFIX,
  UPLOAD_PREFIX,
} from "./format";
import { FilterOptions, isExcluded } from "./filter";
import { changePassword, KeyFile, serializeKeyFile, VaultKeys, WrongPasswordError } from "./keys";
import type { Argon2Params } from "./crypto";
import { Conflict, merge3 } from "./merge";
import { clashKey, conflictName, safePath, uniqueName } from "./names";
import { Repo } from "./repo";
import { AuthError, Endpoint, PushRejectedError, RefInfo, Transport } from "./transport";

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
  /** New data committed since the last download step was marked. */
  bytesSinceStep?: number;
  /** Random id naming this device's upload scratch ref on the hosts. */
  uploadId?: string;
  syncsSinceCompact?: number;
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
  /** Files that were found damaged on this device and restored from the encrypted copy. */
  repaired: string[];
  /** The local repository was damaged and rebuilt from a host's copy. */
  repoRepaired?: boolean;
  /** Large files that no reachable host could provide yet (left as they are). */
  missingLarge: string[];
  /** Set when the local repo was compacted after this sync. */
  compacted?: { objects: number; packsBefore: number; packsAfter: number };
  remotes: RemoteStatus[];
}

/** Retry an operation that fails because a file is briefly locked (common on Windows). */
async function retryBusy<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const code = (e as { code?: string }).code ?? "";
      if (i >= attempts - 1 || !/EBUSY|EPERM|EACCES|ENOTEMPTY|resource busy|locked/i.test(code + " " + (e as Error).message)) throw e;
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
}

/** Errors that mean an object in the local repo is damaged or missing. */
export function isRepoDamage(e: unknown): boolean {
  const m = String((e as Error)?.message ?? e);
  return /Invalid compressed buffer|incorrect header check|invalid (stored block|distance|code)|unexpected end of (file|data)|object corrupt|Could not find [0-9a-f]{7,40}|ReadObjectFail|Expected type/i.test(m);
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
  /** Short status text for long steps (e.g. "Tidying up local history…"). */
  onProgress?: (text: string | null) => void;
}

const MAX_PUSH_ROUNDS = 4;
/** Compact the local repo when this many packs pile up, or after this many syncs. */
const COMPACT_AT_PACKS = 30;
const COMPACT_EVERY_SYNCS = 200;

export class SyncEngine {
  private running: Promise<SyncReport> | null = null;
  /** Refs each host advertised at the last listing (endpoint id -> ref names). */
  private remoteRefs = new Map<string, Set<string>>();

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

  /**
   * Describe what a host holds, for the "Replace with this vault" confirmation.
   * Refuses hosts that hold an encrypted vault (this one or another).
   */
  async inspectForReplace(ep: Endpoint): Promise<{ commits: number; head: string }> {
    const { repo } = this.d;
    await repo.init();
    const head = await this.d.transportFor(ep).fetch(ep);
    if (!head) throw new Error("This repository is empty; a normal sync sets it up, nothing needs replacing");
    if (await repo.keyFileAt(head).catch(() => null)) throw new Error("This repository holds an encrypted vault; it will not be replaced");
    return { commits: (await repo.log(head)).length, head };
  }

  /**
   * Overwrite a host that holds unrelated content with this device's vault, then sync.
   * Only call after the user confirmed. `expectedHead` guards against the host changing meanwhile.
   */
  async replaceHost(ep: Endpoint, expectedHead: string): Promise<SyncReport> {
    while (this.running) await this.running.catch(() => {});
    const p = (async () => {
      const { repo } = this.d;
      const local = await repo.head();
      if (!local || !(await repo.keyFileAt(local))) {
        throw new Error("Sync this device with another host first, so there is a vault to put on this one");
      }
      const now = await this.d.transportFor(ep).fetch(ep);
      if (now !== expectedHead) throw new Error("The repository changed since you checked it; press Test again");
      if (now && (await repo.keyFileAt(now).catch(() => null))) throw new Error("This repository holds an encrypted vault; it will not be replaced");
      await this.d.transportFor(ep).push(ep, local, { force: true });
      return this.run();
    })();
    this.running = p.finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Run a sync; if the local repo turns out to be damaged, repair it once and try again. */
  private async run(): Promise<SyncReport> {
    let r: SyncReport;
    try {
      r = await this.runOnce();
    } catch (e) {
      if (!isRepoDamage(e)) throw e;
      await this.repairRepo();
      r = await this.runOnce();
      r.repoRepaired = true;
    }
    await this.maybeCompact(r);
    return r;
  }

  /** Every so often, tidy the local repo (see Repo.compact). Never fails a sync. */
  private async maybeCompact(r: SyncReport): Promise<void> {
    const state = await this.d.state.load();
    state.syncsSinceCompact = (state.syncsSinceCompact ?? 0) + 1;
    const packs = await this.d.repo.packCount();
    if (packs > COMPACT_AT_PACKS || state.syncsSinceCompact >= COMPACT_EVERY_SYNCS) {
      this.d.onProgress?.("Tidying up local history…");
      try {
        r.compacted = await this.d.repo.compact();
        state.syncsSinceCompact = 0;
      } catch {
        /* try again next time */
      } finally {
        this.d.onProgress?.(null);
      }
    }
    await this.d.state.save(state);
  }

  /**
   * The local repo has a damaged object. Its notes on disk are fine, so go back to the
   * newest intact copy fetched from a host and let the next scan rebuild local changes.
   */
  private async repairRepo(): Promise<void> {
    const { repo } = this.d;
    repo.clearCaches();
    let best: { oid: string; time: number } | null = null;
    for (const ep of this.d.endpoints()) {
      const oid = await repo.remoteHead(ep.id);
      if (!oid) continue;
      try {
        if (!(await repo.keyFileAt(oid))) continue;
        const { time } = await repo.readCommit(oid);
        if (!best || time > best.time) best = { oid, time };
      } catch {
        /* this copy is damaged too */
      }
    }
    if (best) await repo.setHead(best.oid);
    else await repo.deleteHead();
    // Forget what we believed was on disk so every file is checked again.
    const state = await this.d.state.load();
    state.files = {};
    await this.d.state.save(state);
  }

  private async runOnce(): Promise<SyncReport> {
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
        const t = this.d.transportFor(ep);
        const listing: RefInfo[] = await t.listRefs(ep);
        status.get(ep.id)!.reachable = true;
        this.remoteRefs.set(ep.id, new Set(listing.map((r) => r.ref)));
        // Download history in bounded pieces first, oldest step first, so the
        // final fetch of main stays small (see STEP_BYTES).
        let have = await repo.head();
        for (const st of listing.filter((r) => r.ref.startsWith(STEP_PREFIX)).sort((a, b) => (a.ref < b.ref ? -1 : 1))) {
          if (await repo.hasObject(st.oid)) {
            have = st.oid;
            continue;
          }
          await t.fetchRef(ep, st.ref, have);
          have = st.oid;
        }
        const h = await t.fetch(ep, listing, have);
        if (h) {
          const kf = await repo.keyFileAt(h).catch((e) => {
            throw new VaultMismatchError(`Not a Hoard vault: ${e.message}`);
          });
          if (!kf) {
            throw new VaultMismatchError(
              "This repository has other content and is not an encrypted vault, so it was left untouched. " +
                "If it only holds starter files (like a README), press Test in this host's settings and choose “Replace with this vault”.",
            );
          }
          if (identity && kf.keyFile.vaultId !== identity.keyFile.vaultId) {
            throw new VaultMismatchError("This repository holds a different vault; it was left untouched");
          }
          identity ??= kf;
        }
        heads.set(ep.id, h);
      } catch (e) {
        if (isRepoDamage(e)) throw e; // repaired by run()
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
    state.uploadId ??= Array.from(globalThis.crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("");
    const uploadRef = UPLOAD_PREFIX + state.uploadId;

    // 1. Commit what changed in the vault since the last sync.
    const headM = await repo.manifestAt(keys, local);
    const scan = await this.scan(keys, headM, state, opt);
    let cur: string | null = local;
    let curM: Manifest = scan.manifest;
    const committedLocal = scan.changed || isNewVault;
    if (committedLocal) {
      cur = await this.commitLocal(keys, headM, scan.manifest, scan.newSmall, keyFileOid, local, now);
      state.bytesSinceStep = (state.bytesSinceStep ?? 0) + scan.newSmall.reduce((n, x) => n + x.bytes, 0);
      if (state.bytesSinceStep >= STEP_BYTES) {
        await repo.writeStepRef(cur, now);
        state.bytesSinceStep = 0;
      }
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
    const missingLarge: string[] = [];
    let applied = 0;
    const applyAndSetHead = async () => {
      applied += await this.apply(keys, vaultM, curM, state, opt, now, lateConflicts, missingLarge);
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
            try {
              await this.pushExtraRefs(ep, target, heads.get(ep.id) ?? null, uploadRef);
            } catch (e) {
              if (isRepoDamage(e)) throw e;
              fail(ep, e);
              return;
            }
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
              if (isRepoDamage(e)) throw e; // repaired by run()
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
      repaired: scan.repaired,
      missingLarge,
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
    const repaired: string[] = [];
    const newSmall: { path: string; bytes: number }[] = [];
    const seen = new Set<string>();
    for (const f of files) {
      if (isExcluded(f.path, f.size, opt)) continue;
      seen.add(f.path);
      const he = headM.get(f.path);
      const cached = state.files[f.path];
      if (he && cached && cached.s === f.size && cached.t === f.mtime && cached.h === he.h) {
        if (f.size !== he.s) {
          // We recorded writing this exact content, the file hasn't been touched since,
          // yet its size is wrong: an earlier write went bad. Restore it instead of
          // mistaking the damaged file for an edit.
          const good = await this.readEntry(keys, he);
          const st = await this.writeVerified(f.path, good, he.t);
          state.files[f.path] = { s: st.size, t: st.mtime, h: he.h };
          repaired.push(f.path);
        }
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
      const blob = await encryptObject(keys, f.path, id, data);
      const o = await repo.writeBlob(blob);
      const entry: Entry = { p: f.path, i: id, s: data.length, t: f.mtime, h, d: opt.device, o };
      if (blob.length > LARGE_OBJECT_BYTES) {
        await repo.writeLargeRef(o);
        entry.L = 1;
      } else newSmall.push({ path: f.path, bytes: blob.length });
      manifest.set(f.path, entry);
      changed = true;
    }
    for (const p of Object.keys(state.files)) if (!seen.has(p)) delete state.files[p];
    // A large file this device never downloaded (no host had it yet) is not a delete.
    for (const [p, e] of headM) {
      if (!manifest.has(p) && !seen.has(p) && e.L && !(await repo.hasObject(e.o))) manifest.set(p, e);
    }
    for (const p of headM.keys()) if (!manifest.has(p)) changed = true;
    return { manifest, changed, renamed, repaired, newSmall };
  }

  /**
   * Write a file and read it back. Some platforms occasionally leave a file empty
   * (seen on Obsidian for Android), so never trust a write without checking it.
   */
  private async writeVerified(path: string, data: Uint8Array, mtime: number): Promise<{ size: number; mtime: number }> {
    const { vault } = this.d;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        // Windows: a file open in another program (antivirus, indexer) is briefly "busy".
        await vault.write(path, data, attempt === 0 ? mtime : 0);
        const back = await vault.read(path).catch(() => null);
        const st = await vault.stat(path);
        if (back && st && bytesEqual(back, data)) return st;
      } catch (e) {
        lastError = e;
      }
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
    const why = lastError ? ` (${(lastError as Error).message})` : " (it read back different)";
    throw new Error(`Couldn't write "${path}" on this device${why}; the sync was stopped so nothing is lost. Try again.`);
  }

  /**
   * Make sure an entry's encrypted object is in the local repo, downloading a large
   * object's own ref from a host that has it. False when no reachable host has it.
   */
  async ensureObject(e: Entry): Promise<boolean> {
    const { repo } = this.d;
    if (await repo.hasObject(e.o)) return true;
    if (!e.L) return false;
    const ref = LARGE_PREFIX + e.o;
    for (const ep of this.d.endpoints()) {
      const known = this.remoteRefs.get(ep.id);
      if (known && !known.has(ref)) continue;
      try {
        await this.d.transportFor(ep).fetchRef(ep, ref);
        if (await repo.hasObject(e.o)) return true;
      } catch (err) {
        if (isRepoDamage(err)) throw err;
      }
    }
    return false;
  }

  /** Decrypt an entry's content, downloading it first if it is a large file not here yet. */
  async readEntry(keys: VaultKeys, e: Entry): Promise<Uint8Array> {
    if (!(await this.ensureObject(e))) {
      throw new Error(`"${e.p}" is a large file that isn't on this device and no reachable host has it right now`);
    }
    return decryptObject(keys, e.p, e.i, await this.d.repo.readBlob(e.o));
  }

  /**
   * Commit the scanned vault. When the new data is bigger than STEP_BYTES, split it
   * over several commits and mark each as a step, so no single upload or download
   * carries much more than STEP_BYTES.
   */
  private async commitLocal(
    keys: VaultKeys,
    headM: Manifest,
    finalM: Manifest,
    newSmall: { path: string; bytes: number }[],
    keyFileOid: string,
    parent: string | null,
    now: Date,
  ): Promise<string> {
    const { repo } = this.d;
    const total = newSmall.reduce((n, x) => n + x.bytes, 0);
    if (total <= STEP_BYTES) return repo.writeState(keys, finalM, keyFileOid, parent ? [parent] : [], now);
    const chunks: string[][] = [[]];
    let size = 0;
    for (const x of [...newSmall].sort((a, b) => (a.path < b.path ? -1 : 1))) {
      if (size + x.bytes > STEP_BYTES && chunks[chunks.length - 1].length) {
        chunks.push([]);
        size = 0;
      }
      chunks[chunks.length - 1].push(x.path);
      size += x.bytes;
    }
    // Start from the final state with every new/changed small file held back
    // (old version if it existed, absent if new), then add one chunk at a time.
    const partial: Manifest = new Map(finalM);
    for (const x of newSmall) {
      const old = headM.get(x.path);
      if (old) partial.set(x.path, old);
      else partial.delete(x.path);
    }
    let prev = parent;
    for (const chunk of chunks.slice(0, -1)) {
      for (const p of chunk) partial.set(p, finalM.get(p)!);
      prev = await repo.writeState(keys, partial, keyFileOid, prev ? [prev] : [], now);
      await repo.writeStepRef(prev, now);
    }
    return repo.writeState(keys, finalM, keyFileOid, prev ? [prev] : [], now);
  }

  /**
   * Get everything `target` needs onto a host in bounded pieces, before main is moved:
   *  1. large-object refs the host lacks (each carries one file);
   *  2. history: move this device's upload ref forward one step at a time (the host
   *     then only receives what is new since the previous step), marking each step;
   *  3. finally the upload ref reaches `target`, so pushing main sends nothing new.
   */
  private async pushExtraRefs(ep: Endpoint, target: string, remoteMain: string | null, uploadRef: string): Promise<void> {
    const { repo } = this.d;
    const t = this.d.transportFor(ep);
    const known = this.remoteRefs.get(ep.id) ?? new Set<string>();
    for (const { ref, oid } of await repo.listLocalRefs(LARGE_PREFIX)) {
      if (known.has(ref)) continue;
      await t.pushRef(ep, ref, oid);
      known.add(ref);
    }
    const missingSteps = (await repo.listLocalRefs(STEP_PREFIX)).filter((s) => !known.has(s.ref));
    // Upload older history first: order by ancestry (names already sort by time).
    for (let i = 1; i < missingSteps.length; i++) {
      for (let j = i; j > 0 && (await repo.isAncestor(missingSteps[j].oid, missingSteps[j - 1].oid)); j--) {
        [missingSteps[j - 1], missingSteps[j]] = [missingSteps[j], missingSteps[j - 1]];
      }
    }
    if (missingSteps.length || remoteMain !== target) {
      if (!known.has(uploadRef) && remoteMain && (await repo.hasObject(remoteMain))) {
        await t.pushRef(ep, uploadRef, remoteMain, { force: true }); // the host has it all: nothing is sent
        known.add(uploadRef);
      }
      for (const st of missingSteps) {
        await t.pushRef(ep, uploadRef, st.oid, { force: true });
        await t.pushRef(ep, st.ref, st.oid);
        known.add(st.ref);
      }
      if (remoteMain !== target) await t.pushRef(ep, uploadRef, target, { force: true });
      known.add(uploadRef);
    }
    this.remoteRefs.set(ep.id, known);
  }

  /** Re-encrypt entries that moved to a new path (conflict copies, renames, clashes). */
  private async materialize(keys: VaultKeys, result: Map<string, Entry>): Promise<Manifest> {
    const out: Manifest = new Map();
    for (const [path, e] of result) {
      if (e.p === path) {
        out.set(path, e);
        continue;
      }
      const data = await this.readEntry(keys, e);
      const id = await fileId(keys, path);
      const blob = await encryptObject(keys, path, id, data);
      const o = await this.d.repo.writeBlob(blob);
      const moved: Entry = { ...e, p: path, i: id, o };
      delete moved.L;
      if (blob.length > LARGE_OBJECT_BYTES) {
        await this.d.repo.writeLargeRef(o);
        moved.L = 1;
      }
      out.set(path, moved);
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
    missingLarge: string[] = [],
  ): Promise<number> {
    const { vault, repo } = this.d;
    let n = 0;
    for (const [p, e] of from) {
      if (to.has(p) || isExcluded(p, e.s, opt)) continue;
      const m = await this.diskMatches(keys, p, e.h, state);
      if (m === true) {
        await retryBusy(() => vault.remove(p));
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
      if (e.L && !(await this.ensureObject(e))) {
        missingLarge.push(p);
        continue;
      }
      const data = await decryptObject(keys, e.p, e.i, await repo.readBlob(e.o));
      if (target === p) {
        // Last look right before writing, to keep the window for a lost edit tiny.
        const again = await vault.stat(p);
        if ((checked === null) !== (again === null) || (checked && again && (checked.size !== again.size || checked.mtime !== again.mtime))) {
          asConflict();
        }
      }
      const st = await this.writeVerified(target, data, e.t);
      if (target === p) state.files[p] = { s: st.size, t: st.mtime, h: e.h };
      n++;
    }
    return n;
  }
}
