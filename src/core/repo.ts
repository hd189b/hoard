// The local bare Git repository holding encrypted objects and manifest shards.
// Uses isomorphic-git's low-level object API only (no working tree).

import git from "isomorphic-git";
import { fromUtf8 } from "./bytes";
import {
  BRANCH,
  LARGE_PREFIX,
  STEP_PREFIX,
  canonicalShard,
  decryptShard,
  encryptShard,
  Entry,
  FormatError,
  Manifest,
  shardOf,
} from "./format";
import { KEYFILE_PATH, KeyFile, parseKeyFile, VaultKeys } from "./keys";

// isomorphic-git's file system client type
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GitFs = any;

export const AUTHOR = { name: "hoard", email: "sync@invalid" };

let stepCounter = 0;

const LOOSE_OBJECT = /\/objects\/[0-9a-f]{2}\/[0-9a-f]{38}$/;
const OBJECT_FILE = /\/objects\/([0-9a-f]{2}\/[0-9a-f]{38}|pack\/[^/]+)$/;

function enoent(path: string): Error {
  const e = new Error(`ENOENT: ${path}`) as Error & { code: string };
  e.code = "ENOENT";
  return e;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Wrap the file system used for the Git repo:
 *  - every object written is read back and compared (some platforms, notably
 *    Obsidian for Android, occasionally leave a written file empty);
 *  - an empty loose-object file counts as missing (a real Git object is never
 *    empty), so it gets written again instead of being trusted.
 */
export function guardedFs(raw: GitFs): GitFs {
  if (raw.__hoardGuarded) return raw;
  const p = raw.promises;
  const isEmptyLoose = async (path: string) => {
    if (!LOOSE_OBJECT.test(path)) return false;
    try {
      return (await p.stat(path)).size === 0;
    } catch {
      return false;
    }
  };
  const promises = {
    ...p,
    async stat(path: string, ...rest: unknown[]) {
      if (await isEmptyLoose(path)) throw enoent(path);
      return p.stat(path, ...rest);
    },
    async lstat(path: string, ...rest: unknown[]) {
      if (await isEmptyLoose(path)) throw enoent(path);
      return p.lstat(path, ...rest);
    },
    async readFile(path: string, ...rest: unknown[]) {
      if (await isEmptyLoose(path)) throw enoent(path);
      return p.readFile(path, ...rest);
    },
    async writeFile(path: string, data: Uint8Array | string, ...rest: unknown[]) {
      if (!OBJECT_FILE.test(path) || typeof data === "string") return p.writeFile(path, data, ...rest);
      for (let attempt = 0; attempt < 3; attempt++) {
        await p.writeFile(path, data, ...rest);
        const back = await p.readFile(path).catch(() => null);
        if (back && sameBytes(new Uint8Array(back), data)) return;
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
      }
      throw new Error(`Couldn't save ${path.slice(path.lastIndexOf("/objects/") + 1)} correctly on this device; the sync was stopped. Try again.`);
    },
  };
  return { promises, __hoardGuarded: true };
}

interface TreeEntry {
  mode: string;
  path: string;
  oid: string;
  type: "blob" | "tree" | "commit";
}

export interface CommitInfo {
  oid: string;
  parents: string[];
  /** seconds since epoch */
  time: number;
}

export class Repo {
  private readonly cache = {};
  /** shard blob oid -> entries */
  private readonly shardCache = new Map<string, Entry[]>();
  /** canonical shard text -> shard blob oid */
  private readonly canonToBlob = new Map<string, string>();
  /** canonical shard text -> o/<xx> tree oid */
  private readonly canonToObjTree = new Map<string, string>();

  readonly fs: GitFs;

  constructor(
    rawFs: GitFs,
    readonly gitdir: string,
  ) {
    this.fs = guardedFs(rawFs);
  }

  /** Drop caches (after the repo was repaired). */
  clearCaches(): void {
    for (const k of Object.keys(this.cache)) delete (this.cache as Record<string, unknown>)[k];
    this.shardCache.clear();
    this.canonToBlob.clear();
    this.canonToObjTree.clear();
  }

  private get g() {
    return { fs: this.fs, gitdir: this.gitdir, cache: this.cache };
  }

  async init(): Promise<void> {
    try {
      await this.fs.promises.stat(`${this.gitdir}/HEAD`);
      return;
    } catch {
      /* create below */
    }
    await git.init({ fs: this.fs, gitdir: this.gitdir, bare: true, defaultBranch: BRANCH });
  }

  async resolve(ref: string): Promise<string | null> {
    try {
      return await git.resolveRef({ fs: this.fs, gitdir: this.gitdir, ref });
    } catch {
      return null;
    }
  }

  head(): Promise<string | null> {
    return this.resolve(`refs/heads/${BRANCH}`);
  }

  async setHead(oid: string): Promise<void> {
    await git.writeRef({ fs: this.fs, gitdir: this.gitdir, ref: `refs/heads/${BRANCH}`, value: oid, force: true });
  }

  async deleteHead(): Promise<void> {
    await git.deleteRef({ fs: this.fs, gitdir: this.gitdir, ref: `refs/heads/${BRANCH}` }).catch(() => {});
  }

  static remoteRef(remoteId: string): string {
    return `refs/remotes/${remoteId}/${BRANCH}`;
  }

  async setRemoteHead(remoteId: string, oid: string | null): Promise<void> {
    const ref = Repo.remoteRef(remoteId);
    if (oid) await git.writeRef({ fs: this.fs, gitdir: this.gitdir, ref, value: oid, force: true });
    else await git.deleteRef({ fs: this.fs, gitdir: this.gitdir, ref }).catch(() => {});
  }

  remoteHead(remoteId: string): Promise<string | null> {
    return this.resolve(Repo.remoteRef(remoteId));
  }

  async readCommit(oid: string): Promise<CommitInfo> {
    const c = await git.readCommit({ ...this.g, oid });
    return { oid, parents: c.commit.parent, time: c.commit.committer.timestamp };
  }

  private async treeOf(oid: string): Promise<TreeEntry[]> {
    return (await git.readTree({ ...this.g, oid })).tree as TreeEntry[];
  }

  private async rootTree(commit: string): Promise<Map<string, TreeEntry>> {
    const c = await git.readCommit({ ...this.g, oid: commit });
    const t = await this.treeOf(c.commit.tree);
    return new Map(t.map((e) => [e.path, e]));
  }

  async readBlob(oid: string): Promise<Uint8Array> {
    return (await git.readBlob({ ...this.g, oid })).blob;
  }

  async writeBlob(data: Uint8Array): Promise<string> {
    return git.writeBlob({ fs: this.fs, gitdir: this.gitdir, blob: data });
  }

  /** keys.json blob oid at a commit, or null when the commit has none. */
  async keyFileOid(commit: string): Promise<string | null> {
    return (await this.rootTree(commit)).get(KEYFILE_PATH)?.oid ?? null;
  }

  async keyFileAt(commit: string): Promise<{ keyFile: KeyFile; oid: string } | null> {
    const oid = await this.keyFileOid(commit);
    if (!oid) return null;
    return { keyFile: parseKeyFile(fromUtf8(await this.readBlob(oid))), oid };
  }

  /** Blob oids of the manifest shards at a commit. */
  async shardOids(commit: string): Promise<Map<string, string>> {
    const root = await this.rootTree(commit);
    const m = root.get("m");
    if (!m) return new Map();
    return new Map((await this.treeOf(m.oid)).map((e) => [e.path, e.oid]));
  }

  async readShard(keys: VaultKeys, shard: string, oid: string): Promise<Entry[]> {
    let entries = this.shardCache.get(oid);
    if (!entries) {
      entries = await decryptShard(keys, shard, await this.readBlob(oid));
      this.shardCache.set(oid, entries);
      this.canonToBlob.set(canonicalShard(entries), oid);
    }
    return entries;
  }

  async manifestAt(keys: VaultKeys, commit: string | null): Promise<Manifest> {
    const out: Manifest = new Map();
    if (!commit) return out;
    const root = await this.rootTree(commit);
    const shards = root.get("m") ? await this.treeOf(root.get("m")!.oid) : [];
    const objTrees = root.get("o") ? new Map((await this.treeOf(root.get("o")!.oid)).map((e) => [e.path, e.oid])) : new Map();
    for (const s of shards) {
      if (!/^[0-9a-f]{2}$/.test(s.path)) throw new FormatError(`Unexpected manifest entry ${s.path}`);
      const entries = await this.readShard(keys, s.path, s.oid);
      const ot = objTrees.get(s.path);
      if (ot) this.canonToObjTree.set(canonicalShard(entries), ot);
      for (const e of entries) out.set(e.p, e);
    }
    return out;
  }

  /** Entry for one path at a commit, reading only its shard. */
  async entryAt(keys: VaultKeys, commit: string, path: string, id: string): Promise<Entry | null> {
    const shard = shardOf(id);
    const oid = (await this.shardOids(commit)).get(shard);
    if (!oid) return null;
    return (await this.readShard(keys, shard, oid)).find((e) => e.p === path) ?? null;
  }

  /** Write the trees for a manifest and a commit on top of `parents`. */
  async writeState(
    keys: VaultKeys,
    manifest: Manifest,
    keyFileOid: string,
    parents: string[],
    when: Date = new Date(),
  ): Promise<string> {
    const byShard = new Map<string, Entry[]>();
    for (const e of manifest.values()) {
      if (!e.o) throw new Error(`internal: entry ${e.p} has no object`);
      const s = shardOf(e.i);
      byShard.set(s, [...(byShard.get(s) ?? []), e]);
    }
    const mTree: TreeEntry[] = [];
    const oTree: TreeEntry[] = [];
    for (const [shard, entries] of [...byShard].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const canon = canonicalShard(entries);
      let blob = this.canonToBlob.get(canon);
      if (!blob) {
        blob = await this.writeBlob(await encryptShard(keys, shard, canon));
        this.canonToBlob.set(canon, blob);
        this.shardCache.set(blob, entries);
      }
      // Large objects live under their own refs, not in the main tree.
      const inTree = entries.filter((e) => !e.L);
      let ot = this.canonToObjTree.get(canon);
      if (!ot && inTree.length) {
        ot = await git.writeTree({
          fs: this.fs,
          gitdir: this.gitdir,
          tree: inTree.map((e) => ({ mode: "100644", path: e.i, oid: e.o, type: "blob" as const })),
        });
        this.canonToObjTree.set(canon, ot);
      }
      mTree.push({ mode: "100644", path: shard, oid: blob, type: "blob" });
      if (ot) oTree.push({ mode: "040000", path: shard, oid: ot, type: "tree" });
    }
    const root: TreeEntry[] = [{ mode: "100644", path: KEYFILE_PATH, oid: keyFileOid, type: "blob" }];
    if (mTree.length) {
      root.push({ mode: "040000", path: "m", oid: await git.writeTree({ fs: this.fs, gitdir: this.gitdir, tree: mTree }), type: "tree" });
    }
    if (oTree.length) {
      root.push({ mode: "040000", path: "o", oid: await git.writeTree({ fs: this.fs, gitdir: this.gitdir, tree: oTree }), type: "tree" });
    }
    const tree = await git.writeTree({ fs: this.fs, gitdir: this.gitdir, tree: root });
    const sig = { ...AUTHOR, timestamp: Math.floor(when.getTime() / 1000), timezoneOffset: 0 };
    return git.writeCommit({
      fs: this.fs,
      gitdir: this.gitdir,
      commit: { message: "sync\n", tree, parent: parents, author: sig, committer: sig },
    });
  }

  async hasObject(oid: string): Promise<boolean> {
    try {
      await git.readObject({ ...this.g, oid, format: "deflated" });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Keep a large encrypted object under its own ref. The commit is deterministic
   * (fixed time), so every device creates the very same ref for the same object.
   */
  async writeLargeRef(blobOid: string): Promise<string> {
    const tree = await git.writeTree({ fs: this.fs, gitdir: this.gitdir, tree: [{ mode: "100644", path: "b", oid: blobOid, type: "blob" }] });
    const sig = { ...AUTHOR, timestamp: 0, timezoneOffset: 0 };
    const commit = await git.writeCommit({
      fs: this.fs,
      gitdir: this.gitdir,
      commit: { message: "sync\n", tree, parent: [], author: sig, committer: sig },
    });
    await git.writeRef({ fs: this.fs, gitdir: this.gitdir, ref: LARGE_PREFIX + blobOid, value: commit, force: true });
    return commit;
  }

  /** Mark a commit as a download step (see STEP_BYTES). */
  async writeStepRef(commit: string, when: Date = new Date()): Promise<string> {
    const rand = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("");
    // Time, then a counter (several steps can be made in the same millisecond), then randomness.
    const ref = `${STEP_PREFIX}${String(when.getTime()).padStart(14, "0")}-${String(++stepCounter % 1e6).padStart(6, "0")}-${rand}`;
    await git.writeRef({ fs: this.fs, gitdir: this.gitdir, ref, value: commit, force: true });
    return ref;
  }

  /** Local refs under a prefix such as STEP_PREFIX, sorted by name, with their commits. */
  async listLocalRefs(prefix: string): Promise<{ ref: string; oid: string }[]> {
    const names = await git.listRefs({ fs: this.fs, gitdir: this.gitdir, filepath: prefix.replace(/\/$/, "") }).catch(() => [] as string[]);
    const out: { ref: string; oid: string }[] = [];
    for (const n of names.sort()) {
      const ref = prefix + n;
      const oid = await this.resolve(ref);
      if (oid) out.push({ ref, oid });
    }
    return out;
  }

  /** Number of pack files (cheap: one directory listing). */
  async packCount(): Promise<number> {
    try {
      return ((await this.fs.promises.readdir(`${this.gitdir}/objects/pack`)) as string[]).filter((n) => n.endsWith(".pack")).length;
    } catch {
      return 0;
    }
  }

  /**
   * Rewrite everything still referenced into packs of at most `maxPackBytes`, then
   * remove the old packs and loose objects. Many small files and packs make every
   * operation slower (badly so on Android). New packs are complete and indexed before
   * anything is deleted, so an interruption loses nothing.
   */
  async compact(maxPackBytes = 8 * 1024 * 1024): Promise<{ objects: number; packsBefore: number; packsAfter: number }> {
    const g = { fs: this.fs, gitdir: this.gitdir };
    const packDir = `${this.gitdir}/objects/pack`;
    const oldPacks = ((await this.fs.promises.readdir(packDir).catch(() => [])) as string[]).filter((n) => /\.(pack|idx)$/.test(n));
    // 1. Everything reachable from any ref.
    const refs = (await git.listRefs({ ...g, filepath: "refs" }).catch(() => [] as string[])).map((r) => `refs/${r}`);
    const head = await this.head();
    const visited = new Map<string, number>(); // oid -> stored size
    const sizeOf = async (oid: string) => ((await git.readObject({ ...g, cache: this.cache, oid, format: "deflated" })).object as Uint8Array).length;
    const stack: { oid: string; type: "commit" | "tree" | "blob" }[] = [];
    for (const r of refs) {
      const oid = await this.resolve(r);
      if (oid) stack.push({ oid, type: "commit" });
    }
    if (head) stack.push({ oid: head, type: "commit" });
    while (stack.length) {
      const { oid, type } = stack.pop()!;
      if (visited.has(oid)) continue;
      visited.set(oid, await sizeOf(oid));
      if (type === "commit") {
        const c = await git.readCommit({ ...g, cache: this.cache, oid });
        stack.push({ oid: c.commit.tree, type: "tree" });
        for (const p of c.commit.parent) stack.push({ oid: p, type: "commit" });
      } else if (type === "tree") {
        for (const e of (await git.readTree({ ...g, cache: this.cache, oid })).tree) {
          if (e.type === "tree" || e.type === "blob") stack.push({ oid: e.oid, type: e.type });
        }
      }
    }
    // 2. New packs, each at most maxPackBytes (a bigger single object gets its own).
    const batches: string[][] = [[]];
    let size = 0;
    for (const [oid, n] of visited) {
      if (size + n > maxPackBytes && batches[batches.length - 1].length) {
        batches.push([]);
        size = 0;
      }
      batches[batches.length - 1].push(oid);
      size += n;
    }
    const newNames = new Set<string>();
    for (const batch of batches.filter((b) => b.length)) {
      const { filename } = await git.packObjects({ ...g, cache: this.cache, oids: batch, write: true });
      await git.indexPack({ fs: this.fs, dir: this.gitdir, gitdir: this.gitdir, filepath: `objects/pack/${filename}`, cache: this.cache });
      newNames.add(filename);
      newNames.add(filename.replace(/\.pack$/, ".idx"));
    }
    // 3. Only now remove what the new packs replace.
    for (const n of oldPacks) if (!newNames.has(n)) await this.fs.promises.unlink(`${packDir}/${n}`).catch(() => {});
    for (const dir of (await this.fs.promises.readdir(`${this.gitdir}/objects`)) as string[]) {
      if (!/^[0-9a-f]{2}$/.test(dir)) continue;
      for (const f of (await this.fs.promises.readdir(`${this.gitdir}/objects/${dir}`)) as string[]) {
        await this.fs.promises.unlink(`${this.gitdir}/objects/${dir}/${f}`).catch(() => {});
      }
      await this.fs.promises.rmdir(`${this.gitdir}/objects/${dir}`).catch(() => {});
    }
    this.clearCaches();
    return { objects: visited.size, packsBefore: oldPacks.filter((n) => n.endsWith(".pack")).length, packsAfter: newNames.size / 2 };
  }

  /** True if `ancestor` is reachable from `oid` (or equal to it). */
  async isAncestor(ancestor: string, oid: string): Promise<boolean> {
    if (ancestor === oid) return true;
    return git.isDescendent({ ...this.g, oid, ancestor, depth: -1 });
  }

  async mergeBase(a: string, b: string): Promise<string | null> {
    const r = await git.findMergeBase({ ...this.g, oids: [a, b] });
    return r[0] ?? null;
  }

  /** All commits reachable from `ref`, newest first. */
  async log(ref: string): Promise<CommitInfo[]> {
    const l = await git.log({ ...this.g, ref });
    return l.map((c) => ({ oid: c.oid, parents: c.commit.parent, time: c.commit.committer.timestamp }));
  }
}
