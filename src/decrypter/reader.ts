// Read-only access to an encgidian repository on disk: unlock, list syncs,
// browse snapshots, file versions, deleted files, export. Never writes to the repo.

import * as fs from "fs";
import * as path from "path";
import { DeletedFile, deletedFiles, fileVersions, readEntry, Version } from "../core/history";
import { KeyFile, parseRecoveryKey, unlockWithPassword, unlockWithRawKey, VaultKeys } from "../core/keys";
import { Manifest, normalizePath } from "../core/format";
import { CommitInfo, Repo } from "../core/repo";

export class ReaderError extends Error {}

/** Find the Git directory: a clone (folder with .git) or a bare repository. */
export function findGitDir(dir: string): string {
  const abs = path.resolve(dir);
  if (fs.existsSync(path.join(abs, ".git", "HEAD"))) return path.join(abs, ".git");
  if (fs.existsSync(path.join(abs, "HEAD")) && fs.existsSync(path.join(abs, "objects"))) return abs;
  throw new ReaderError(`${abs} is not a Git repository (no .git folder, not a bare repo)`);
}

const CANDIDATE_REFS = ["refs/heads/main", "refs/remotes/origin/main", "HEAD"];

export class VaultReader {
  readonly repo: Repo;
  head!: string;
  keyFile!: KeyFile;
  keys: VaultKeys | null = null;
  private commitList: CommitInfo[] | null = null;

  private constructor(readonly gitdir: string) {
    this.repo = new Repo(fs, gitdir);
  }

  static async open(dir: string): Promise<VaultReader> {
    const r = new VaultReader(findGitDir(dir));
    let head: string | null = null;
    for (const ref of CANDIDATE_REFS) {
      head = await r.repo.resolve(ref);
      if (head) break;
    }
    if (!head) throw new ReaderError("The repository is empty (no main branch)");
    r.head = head;
    const kf = await r.repo.keyFileAt(head).catch((e) => {
      throw new ReaderError(e.message);
    });
    if (!kf) throw new ReaderError("This repository is not a Hoard vault (no keys.json)");
    r.keyFile = kf.keyFile;
    return r;
  }

  get unlocked() {
    return this.keys !== null;
  }

  async unlockPassword(pw: string) {
    this.keys = await unlockWithPassword(this.keyFile, pw);
  }

  async unlockRecoveryKey(text: string) {
    this.keys = await unlockWithRawKey(this.keyFile, parseRecoveryKey(text));
  }

  private k(): VaultKeys {
    if (!this.keys) throw new ReaderError("Locked");
    return this.keys;
  }

  async commits(): Promise<CommitInfo[]> {
    this.commitList ??= await this.repo.log(this.head);
    return this.commitList;
  }

  /** A commit id, an unambiguous prefix, or "latest". */
  async resolveCommit(ref?: string): Promise<string> {
    if (!ref || ref === "latest") return this.head;
    const m = (await this.commits()).filter((c) => c.oid.startsWith(ref));
    if (m.length !== 1) throw new ReaderError(m.length ? `"${ref}" matches several syncs` : `No sync "${ref}"`);
    return m[0].oid;
  }

  snapshot(commit: string): Promise<Manifest> {
    return this.repo.manifestAt(this.k(), commit);
  }

  versions(p: string): Promise<Version[]> {
    return fileVersions(this.repo, this.k(), this.head, p);
  }

  deleted(): Promise<DeletedFile[]> {
    return deletedFiles(this.repo, this.k(), this.head);
  }

  async read(commit: string, p: string): Promise<{ data: Uint8Array; mtime: number }> {
    const e = (await this.snapshot(commit)).get(normalizePath(p));
    if (!e) throw new ReaderError(`"${p}" isn't in that sync`);
    return { data: await this.readObject(e), mtime: e.t };
  }

  /** Decrypt one entry. Large files live under their own refs, which a plain clone doesn't download. */
  async readObject(e: Version["entry"]): Promise<Uint8Array> {
    if (e.L && !(await this.repo.hasObject(e.o))) {
      throw new ReaderError(
        `"${e.p}" is a large file stored outside the main history, and this clone doesn't include it. ` +
          `Clone with "git clone --mirror <url>" to get large files too.`,
      );
    }
    return readEntry(this.repo, this.k(), e);
  }

  /** Write every file of a snapshot under `out`. Refuses to write outside it. */
  async exportTo(commit: string, out: string, onFile?: (p: string) => void, skipped: string[] = []): Promise<number> {
    const root = path.resolve(out);
    const m = await this.snapshot(commit);
    let n = 0;
    for (const [p, e] of m) {
      const dest = path.resolve(root, ...p.split("/"));
      if (!dest.startsWith(root + path.sep)) throw new ReaderError(`Unsafe path in vault: ${p}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (e.L && !(await this.repo.hasObject(e.o))) {
        skipped.push(p);
        continue;
      }
      fs.writeFileSync(dest, await readEntry(this.repo, this.k(), e));
      if (e.t > 0) fs.utimesSync(dest, new Date(), new Date(e.t));
      onFile?.(p);
      n++;
    }
    return n;
  }
}
