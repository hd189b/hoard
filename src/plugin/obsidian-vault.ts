// VaultIO and StateStore on top of Obsidian's APIs.
// Normal files go through the Vault API (so Obsidian notices changes and the
// user's trash setting applies); hidden files (".obsidian/…") through the adapter.

import { App, normalizePath, Platform, TFile, TFolder } from "obsidian";
import type { LocalState, StateStore, VaultFileInfo, VaultIO } from "../core/sync";

const isHidden = (p: string) => p.split("/").some((s) => s.startsWith("."));
const toAB = (d: Uint8Array) => d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer;

export class ObsidianVault implements VaultIO {
  /** Paths this plugin wrote recently, so their change events don't trigger another sync. */
  readonly selfWrites = new Map<string, number>();

  constructor(private readonly app: App) {}

  private mark(p: string) {
    this.selfWrites.set(p, Date.now());
  }

  async list(): Promise<VaultFileInfo[]> {
    const a = this.app.vault.adapter;
    const out: VaultFileInfo[] = [];
    const walk = async (dir: string) => {
      const l = await a.list(dir);
      for (const f of l.files) {
        const st = await a.stat(f);
        if (st?.type === "file") out.push({ path: normalizePath(f), size: st.size, mtime: Math.floor(st.mtime) });
      }
      for (const d of l.folders) await walk(d);
    };
    await walk("");
    return out;
  }

  async stat(p: string) {
    const st = await this.app.vault.adapter.stat(p);
    return st?.type === "file" ? { size: st.size, mtime: Math.floor(st.mtime) } : null;
  }

  async read(p: string) {
    return new Uint8Array(await this.app.vault.adapter.readBinary(p));
  }

  private async ensureFolder(p: string) {
    const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
    if (!dir || (await this.app.vault.adapter.exists(dir))) return;
    if (isHidden(dir)) await this.app.vault.adapter.mkdir(dir);
    else await this.app.vault.createFolder(dir).catch(() => this.app.vault.adapter.mkdir(dir));
  }

  async write(p: string, data: Uint8Array, mtime: number) {
    this.mark(p);
    // Obsidian for Android sometimes leaves a file empty when asked to set its
    // modified time while writing, so only keep original times on desktop.
    const opts = mtime > 0 && Platform.isDesktopApp ? { mtime } : undefined;
    const f = this.app.vault.getAbstractFileByPath(p);
    if (f instanceof TFile) return this.app.vault.modifyBinary(f, toAB(data), opts);
    await this.ensureFolder(p);
    if (isHidden(p)) return this.app.vault.adapter.writeBinary(p, toAB(data), opts);
    await this.app.vault.createBinary(p, toAB(data), opts);
  }

  async remove(p: string) {
    this.mark(p);
    const f = this.app.vault.getAbstractFileByPath(p);
    if (f instanceof TFile) {
      // Follows the user's "Deleted files" setting. Obsidian only shows a notice when
      // the system trash fails, so check, and fall back to the vault's .trash folder.
      await this.app.fileManager.trashFile(f).catch(() => {});
      if (await this.app.vault.adapter.exists(p)) await this.app.vault.trash(f, false).catch(() => {});
    } else {
      await this.app.vault.adapter.remove(p);
    }
    if (await this.app.vault.adapter.exists(p)) throw new Error(`Couldn't delete “${p}”`);
    await this.removeEmptyParents(p);
  }

  /** Remove folders that became empty because a synced delete emptied them. */
  private async removeEmptyParents(p: string) {
    let dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
    while (dir) {
      const l = await this.app.vault.adapter.list(dir).catch(() => null);
      if (!l || l.files.length || l.folders.length) return;
      const f = this.app.vault.getAbstractFileByPath(dir);
      if (f instanceof TFolder) await this.app.vault.delete(f, true);
      else await this.app.vault.adapter.rmdir(dir, false);
      dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
    }
  }

  async rename(from: string, to: string) {
    this.mark(from);
    this.mark(to);
    await this.ensureFolder(to);
    const f = this.app.vault.getAbstractFileByPath(from);
    if (f instanceof TFile) await this.app.vault.rename(f, to);
    else await this.app.vault.adapter.rename(from, to);
  }
}

export class AdapterState implements StateStore {
  constructor(
    private readonly app: App,
    private readonly file: string,
  ) {}
  async load(): Promise<LocalState> {
    try {
      return JSON.parse(await this.app.vault.adapter.read(this.file));
    } catch {
      return { files: {} };
    }
  }
  async save(s: LocalState) {
    await this.app.vault.adapter.write(this.file, JSON.stringify(s));
  }
}
