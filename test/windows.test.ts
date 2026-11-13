// Windows behaviour simulated on Linux: case-insensitive NTFS folders, files locked
// by other programs, and Windows paths in the SSH/proxy commands.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GitServer } from "./helpers/gitserver";
import { Device } from "./helpers/device";
import { sshCommand } from "../src/platform/git-cli";

let tmp: string;
let s1: GitServer;
beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "egw-"));
  s1 = new GitServer(path.join(tmp, "s1"));
  s1.createRepo();
  await s1.start();
});
afterEach(async () => {
  await s1.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const linux = () => new Device("Linux", path.join(tmp, "linux"), { servers: [s1] });
const windows = () => new Device("Windows", path.join(tmp, "win"), { servers: [s1], ntfs: true });
const names = (d: Device) => fs.readdirSync(d.vaultDir).sort();

describe("Windows (NTFS, case-insensitive)", () => {
  it("a case-only rename on Linux arrives as a rename, and stays stable", async () => {
    const l = linux();
    const w = windows();
    l.put("Note.md", "hello");
    await l.sync();
    await w.sync();
    fs.renameSync(path.join(l.vaultDir, "Note.md"), path.join(l.vaultDir, "note.md"));
    await l.sync();
    await w.sync();
    expect(names(w)).toEqual(["note.md"]);
    expect(w.file("note.md")).toBe("hello");
    // Nothing flips back and forth afterwards.
    expect((await w.sync()).committedLocal).toBe(false);
    expect((await l.sync()).committedLocal).toBe(false);
    expect(names(l)).toEqual(["note.md"]);
  });

  it("two names that differ only in case on Linux both arrive on Windows", async () => {
    const l = linux();
    const w = windows();
    l.put("Report.md", "upper");
    l.put("report.md", "lower");
    await l.sync();
    await w.sync();
    expect(names(w)).toHaveLength(2);
    expect(Object.values(w.files()).sort()).toEqual(["lower", "upper"]);
    expect(w.files()).toEqual(l.files());
  });

  it("Windows and Linux create the same name in different case", async () => {
    const l = linux();
    const w = windows();
    await l.sync();
    await w.sync();
    l.put("Plan.md", "from linux");
    w.put("plan.md", "from windows");
    await l.sync();
    const r = await w.sync();
    await l.sync();
    expect(r.clashes).toEqual([{ from: "plan.md", to: "plan (1).md" }]);
    expect(w.files()).toEqual({ "Plan.md": "from linux", "plan (1).md": "from windows" });
    expect(l.files()).toEqual(w.files());
  });

  it("files briefly locked by another program are retried, not lost", async () => {
    const l = linux();
    const w = windows();
    l.put("a.md", "1");
    l.put("b.md", "1");
    await l.sync();
    await w.sync();
    l.put("a.md", "2");
    l.del("b.md");
    await l.sync();
    const busy = () => Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    const realWrite = w.vault.write.bind(w.vault);
    const realRemove = w.vault.remove.bind(w.vault);
    let wFails = 2;
    let rFails = 2;
    w.vault.write = async (p, d, m) => {
      if (wFails-- > 0) throw busy();
      return realWrite(p, d, m);
    };
    w.vault.remove = async (p) => {
      if (rFails-- > 0) throw busy();
      return realRemove(p);
    };
    await w.sync();
    expect(w.files()).toEqual({ "a.md": "2" });
  });
});

describe("Windows paths in Git commands", () => {
  it("quotes key and known_hosts paths with spaces and backslashes", () => {
    const cmd = sshCommand(
      { sshKeyPath: "C:\\Users\\John Doe\\.ssh\\id_ed25519" },
      { helperDir: "C:\\Users\\John Doe\\Vault\\.obsidian\\plugins\\encgidian\\ssh", proxy: "socks5://127.0.0.1:1080" },
      true,
    );
    expect(cmd).toContain('-i "C:/Users/John Doe/.ssh/id_ed25519"');
    expect(cmd).toContain('UserKnownHostsFile="C:/Users/John Doe/Vault/.obsidian/plugins/encgidian/ssh/known_hosts"');
    expect(cmd).toContain('ProxyCommand=connect -S 127.0.0.1:1080 %h %p');
    expect(cmd).not.toContain("\\");
  });
});
