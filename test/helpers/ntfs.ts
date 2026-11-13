// A VaultIO that behaves like a Windows (NTFS) folder: names are case-insensitive
// but case-preserving. Writing "note.md" when "Note.md" exists overwrites Note.md
// and keeps the name "Note.md"; a case-only rename changes the stored name.

import * as fs from "fs";
import * as path from "path";
import { FolderVault } from "../../src/platform/vault-node";

export class NtfsVault extends FolderVault {
  /** Map a requested path to the existing file's real casing, segment by segment. */
  private real(p: string): string {
    let dir = this.root;
    const out: string[] = [];
    for (const seg of p.split("/")) {
      let name = seg;
      try {
        const hit = fs.readdirSync(dir).find((n) => n.toLowerCase() === seg.toLowerCase());
        if (hit) name = hit;
      } catch {
        /* directory doesn't exist yet */
      }
      out.push(name);
      dir = path.join(dir, name);
    }
    return out.join("/");
  }
  override async stat(p: string) {
    return super.stat(this.real(p));
  }
  override async read(p: string) {
    return super.read(this.real(p));
  }
  override async write(p: string, data: Uint8Array, mtime: number) {
    return super.write(this.real(p), data, mtime);
  }
  override async remove(p: string) {
    return super.remove(this.real(p));
  }
  override async rename(from: string, to: string) {
    const src = this.real(from);
    // A case-only rename is allowed on NTFS; otherwise the target must not already exist.
    const dst = src.toLowerCase() === to.toLowerCase() ? to : this.real(to);
    return super.rename(src, dst);
  }
}
