// The local bare Git repository holding encrypted objects and manifest shards.
// Uses isomorphic-git's low-level object API only (no working tree).

import git from "isomorphic-git";
import { fromUtf8 } from "./bytes";
import {
  BRANCH,
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

export const AUTHOR = { name: "encgidian", email: "sync@invalid" };

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

  constructor(
    readonly fs: GitFs,
    readonly gitdir: string,
  ) {}

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
      let ot = this.canonToObjTree.get(canon);
      if (!ot) {
        ot = await git.writeTree({
          fs: this.fs,
          gitdir: this.gitdir,
          tree: entries.map((e) => ({ mode: "100644", path: e.i, oid: e.o, type: "blob" as const })),
        });
        this.canonToObjTree.set(canon, ot);
      }
      mTree.push({ mode: "100644", path: shard, oid: blob, type: "blob" });
      oTree.push({ mode: "040000", path: shard, oid: ot, type: "tree" });
    }
    const root: TreeEntry[] = [{ mode: "100644", path: KEYFILE_PATH, oid: keyFileOid, type: "blob" }];
    if (mTree.length) {
      root.push({ mode: "040000", path: "m", oid: await git.writeTree({ fs: this.fs, gitdir: this.gitdir, tree: mTree }), type: "tree" });
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
