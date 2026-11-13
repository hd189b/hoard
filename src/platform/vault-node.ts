// VaultIO and StateStore backed by a plain folder (tests, decrypter export).

import { promises as fsp } from "fs";
import * as path from "path";
import type { LocalState, StateStore, VaultFileInfo, VaultIO } from "../core/sync";

export class FolderVault implements VaultIO {
  constructor(readonly root: string) {}

  private abs(p: string) {
    return path.join(this.root, ...p.split("/"));
  }

  async list(): Promise<VaultFileInfo[]> {
    const out: VaultFileInfo[] = [];
    const walk = async (dir: string, rel: string) => {
      let names: import("fs").Dirent[];
      try {
        names = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const d of names) {
        const r = rel ? `${rel}/${d.name}` : d.name;
        if (d.isDirectory()) await walk(path.join(dir, d.name), r);
        else if (d.isFile()) {
          const st = await fsp.stat(path.join(dir, d.name));
          out.push({ path: r, size: st.size, mtime: Math.floor(st.mtimeMs) });
        }
      }
    };
    await walk(this.root, "");
    return out;
  }

  async stat(p: string) {
    try {
      const st = await fsp.stat(this.abs(p));
      return st.isFile() ? { size: st.size, mtime: Math.floor(st.mtimeMs) } : null;
    } catch {
      return null;
    }
  }

  async read(p: string) {
    return new Uint8Array(await fsp.readFile(this.abs(p)));
  }

  async write(p: string, data: Uint8Array, mtime: number) {
    const a = this.abs(p);
    await fsp.mkdir(path.dirname(a), { recursive: true });
    await fsp.writeFile(a, data);
    if (mtime > 0) await fsp.utimes(a, new Date(), new Date(mtime));
  }

  async remove(p: string) {
    await fsp.rm(this.abs(p), { force: true });
  }

  async rename(from: string, to: string) {
    const a = this.abs(to);
    await fsp.mkdir(path.dirname(a), { recursive: true });
    await fsp.rename(this.abs(from), a);
  }
}

export class JsonFileState implements StateStore {
  constructor(readonly file: string) {}
  async load(): Promise<LocalState> {
    try {
      return JSON.parse(await fsp.readFile(this.file, "utf8"));
    } catch {
      return { files: {} };
    }
  }
  async save(s: LocalState) {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(s));
    await fsp.rename(tmp, this.file);
  }
}
