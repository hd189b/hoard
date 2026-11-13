// A Node-style `fs.promises` for isomorphic-git, built on Obsidian's DataAdapter.
// Used on Android, where Node's fs isn't available. Paths are vault-relative.

import type { DataAdapter } from "obsidian";

function fsError(code: string, path: string): Error {
  const e = new Error(`${code}: ${path}`) as Error & { code: string };
  e.code = code;
  return e;
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "").replace(/\/+/g, "/");

class Stats {
  constructor(
    private readonly kind: "file" | "folder",
    readonly size: number,
    readonly mtimeMs: number,
    readonly ctimeMs: number,
  ) {}
  isFile() {
    return this.kind === "file";
  }
  isDirectory() {
    return this.kind === "folder";
  }
  isSymbolicLink() {
    return false;
  }
  get mode() {
    return this.kind === "file" ? 0o100644 : 0o040000;
  }
  get mtime() {
    return new Date(this.mtimeMs);
  }
  get ctime() {
    return new Date(this.ctimeMs);
  }
  readonly uid = 1;
  readonly gid = 1;
  readonly dev = 1;
  readonly ino = 1;
}

export function adapterFs(adapter: DataAdapter) {
  const promises = {
    async readFile(path: string, opts?: string | { encoding?: string }) {
      const p = norm(path);
      const st = await adapter.stat(p);
      if (!st || st.type !== "file") throw fsError("ENOENT", p);
      const encoding = typeof opts === "string" ? opts : opts?.encoding;
      if (encoding === "utf8" || encoding === "utf-8") return adapter.read(p);
      return new Uint8Array(await adapter.readBinary(p));
    },
    async writeFile(path: string, data: Uint8Array | string) {
      const p = norm(path);
      if (typeof data === "string") await adapter.write(p, data);
      else await adapter.writeBinary(p, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
    },
    async unlink(path: string) {
      const p = norm(path);
      if (!(await adapter.exists(p))) throw fsError("ENOENT", p);
      await adapter.remove(p);
    },
    async readdir(path: string) {
      const p = norm(path);
      const st = await adapter.stat(p);
      if (!st) throw fsError("ENOENT", p);
      if (st.type !== "folder") throw fsError("ENOTDIR", p);
      const l = await adapter.list(p);
      return [...l.files, ...l.folders].map((f) => f.slice(f.lastIndexOf("/") + 1));
    },
    async mkdir(path: string) {
      const p = norm(path);
      if (await adapter.exists(p)) throw fsError("EEXIST", p);
      const parent = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
      if (parent && !(await adapter.exists(parent))) throw fsError("ENOENT", parent);
      await adapter.mkdir(p);
    },
    async rmdir(path: string) {
      const p = norm(path);
      if (!(await adapter.exists(p))) throw fsError("ENOENT", p);
      await adapter.rmdir(p, false);
    },
    async stat(path: string) {
      const p = norm(path);
      const st = await adapter.stat(p);
      if (!st) throw fsError("ENOENT", p);
      return new Stats(st.type, st.size, st.mtime, st.ctime);
    },
    async lstat(path: string) {
      return promises.stat(path);
    },
    async readlink(path: string): Promise<string> {
      throw fsError("ENOENT", path);
    },
    async symlink(): Promise<void> {
      throw fsError("EPERM", "symlink");
    },
    async chmod(): Promise<void> {},
  };
  return { promises };
}
