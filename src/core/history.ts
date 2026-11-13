// Reading history: older versions of a file, deleted files, whole snapshots.
// Used by the plugin's restore commands and by the standalone decrypter.

import { decryptObject, Entry, fileId, Manifest, normalizePath } from "./format";
import type { VaultKeys } from "./keys";
import { CommitInfo, Repo } from "./repo";

export interface Version {
  /** Commit where this content first appeared. */
  commit: string;
  /** Seconds since epoch of that commit. */
  time: number;
  entry: Entry;
}

/** Distinct versions of one file, newest first. */
export async function fileVersions(repo: Repo, keys: VaultKeys, head: string, path: string): Promise<Version[]> {
  const p = normalizePath(path);
  const id = await fileId(keys, p);
  const byObj = new Map<string, Version>();
  const order: string[] = [];
  for (const c of await repo.log(head)) {
    const e = await repo.entryAt(keys, c.oid, p, id);
    if (!e) continue;
    const v = byObj.get(e.o);
    if (v) {
      if (c.time < v.time) Object.assign(v, { commit: c.oid, time: c.time });
    } else {
      byObj.set(e.o, { commit: c.oid, time: c.time, entry: e });
      order.push(e.o);
    }
  }
  return order.map((o) => byObj.get(o)!).sort((a, b) => b.time - a.time);
}

export interface DeletedFile {
  path: string;
  /** Last version before it was deleted. */
  last: Version;
}

/** Files that existed at some point but are not in `head`, newest deletion first. */
export async function deletedFiles(repo: Repo, keys: VaultKeys, head: string): Promise<DeletedFile[]> {
  const current = await repo.manifestAt(keys, head);
  const found = new Map<string, DeletedFile>();
  for (const c of await repo.log(head)) {
    const m = await repo.manifestAt(keys, c.oid);
    for (const [p, e] of m) {
      if (current.has(p) || found.has(p)) continue;
      found.set(p, { path: p, last: { commit: c.oid, time: c.time, entry: e } });
    }
  }
  return [...found.values()].sort((a, b) => b.last.time - a.last.time);
}

export function snapshot(repo: Repo, keys: VaultKeys, commit: string): Promise<Manifest> {
  return repo.manifestAt(keys, commit);
}

export async function readEntry(repo: Repo, keys: VaultKeys, e: Entry): Promise<Uint8Array> {
  return decryptObject(keys, e.p, e.i, await repo.readBlob(e.o));
}

export function commits(repo: Repo, head: string): Promise<CommitInfo[]> {
  return repo.log(head);
}
