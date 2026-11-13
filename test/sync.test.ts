import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { GitServer } from "./helpers/gitserver";
import { Device } from "./helpers/device";
import { WrongPasswordError } from "../src/core/keys";

let tmp: string;
let s1: GitServer;
let s2: GitServer;
let devices: Device[];

const mk = (name: string, o: Partial<ConstructorParameters<typeof Device>[2]> = {}) => {
  const d = new Device(name, path.join(tmp, name), { servers: [s1, s2], ...o });
  devices.push(d);
  return d;
};

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "egd-"));
  s1 = new GitServer(path.join(tmp, "s1"));
  s2 = new GitServer(path.join(tmp, "s2"));
  s1.createRepo();
  s2.createRepo();
  await s1.start();
  await s2.start();
  devices = [];
});

afterEach(async () => {
  await s1.stop();
  await s2.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Both servers and the device all point at the same commit. */
const allAt = (d: Device, head: string | null) => {
  expect(head).toBeTruthy();
  expect(s1.head()).toBe(head);
  expect(s2.head()).toBe(head);
};

describe("two devices, two servers", () => {
  it("sets up an empty repo and copies files to a second device", async () => {
    const pc = mk("PC");
    pc.put("Hello.md", "hello world");
    pc.put("folder/sub/Note.md", "deep note");
    const r = await pc.sync();
    expect(r.remotes.every((x) => x.upToDate)).toBe(true);
    allAt(pc, r.head);

    const phone = mk("Phone");
    const r2 = await phone.sync();
    expect(r2.head).toBe(r.head);
    expect(phone.files()).toEqual({ "Hello.md": "hello world", "folder/sub/Note.md": "deep note" });
  });

  it("carries edits, adds and deletes both ways", async () => {
    const pc = mk("PC");
    const phone = mk("Phone");
    pc.put("a.md", "1");
    pc.put("b.md", "1");
    await pc.sync();
    await phone.sync();

    pc.put("a.md", "2");
    phone.del("b.md");
    phone.put("c.md", "new");
    await pc.sync();
    await phone.sync();
    const r = await pc.sync();
    expect(pc.files()).toEqual({ "a.md": "2", "c.md": "new" });
    expect(phone.files()).toEqual({ "a.md": "2", "c.md": "new" });
    allAt(pc, r.head);
  });

  it("makes a conflict copy when both devices edit before syncing", async () => {
    const pc = mk("PC");
    const phone = mk("Phone");
    pc.put("Plan.md", "A");
    await pc.sync();
    await phone.sync();

    pc.put("Plan.md", "B");
    phone.put("Plan.md", "C");
    const r1 = await pc.sync();
    expect(r1.conflicts).toEqual([]);
    const r2 = await phone.sync();
    expect(r2.conflicts).toHaveLength(1);
    const copy = r2.conflicts[0].copy;
    expect(copy).toMatch(/^Plan \(conflict \d{4}-\d\d-\d\d \d{4} Phone\)\.md$/);
    expect(phone.file("Plan.md")).toBe("B");
    expect(phone.file(copy)).toBe("C");
    await pc.sync();
    expect(pc.files()).toEqual(phone.files());
  });

  it("delete on one side, edit on the other keeps the edit", async () => {
    const pc = mk("PC");
    const phone = mk("Phone");
    pc.put("x.md", "v1");
    await pc.sync();
    await phone.sync();
    pc.del("x.md");
    phone.put("x.md", "v2");
    await pc.sync();
    await phone.sync();
    await pc.sync();
    expect(pc.file("x.md")).toBe("v2");
    expect(phone.file("x.md")).toBe("v2");
  });

  it("an edit follows a rename made on the other device", async () => {
    const pc = mk("PC");
    const phone = mk("Phone");
    pc.put("old.md", "v1");
    await pc.sync();
    await phone.sync();
    pc.mv("old.md", "dir/new.md");
    phone.put("old.md", "v2");
    await pc.sync();
    await phone.sync();
    await pc.sync();
    expect(pc.files()).toEqual({ "dir/new.md": "v2" });
    expect(phone.files()).toEqual({ "dir/new.md": "v2" });
  });
});

describe("redundancy", () => {
  it("a host that was down is brought fully up to date when it returns", async () => {
    const pc = mk("PC");
    const phone = mk("Phone");
    pc.put("a.md", "1");
    await pc.sync();
    await phone.sync();

    s2.down = true;
    for (let i = 2; i <= 4; i++) {
      pc.put("a.md", String(i));
      const r = await pc.sync();
      expect(r.remotes.find((x) => x.name === "server1")!.reachable).toBe(false);
      expect(r.remotes.find((x) => x.name === "server0")!.upToDate).toBe(true);
    }
    await phone.sync();
    expect(phone.file("a.md")).toBe("4");
    const behind = s2.head();
    s2.down = false;
    // No new edits at all: the sync still repairs the lagging host.
    const r = await phone.sync();
    expect(r.committedLocal).toBe(false);
    expect(s2.head()).not.toBe(behind);
    allAt(phone, r.head);
    // The repaired host alone has the whole history.
    const log = execFileSync("git", ["-C", path.join(tmp, "s2", "vault.git"), "rev-list", "--count", "main"]).toString();
    expect(Number(log)).toBeGreaterThanOrEqual(4);
  });

  it("commits that reached only one host spread to the others", async () => {
    const pc = mk("PC");
    const phone = mk("Phone");
    pc.put("a.md", "1");
    await pc.sync();
    await phone.sync();
    // Phone can only reach server0, PC only server1, and both edit the same note.
    s1.down = false;
    s2.down = true;
    phone.put("a.md", "phone");
    await phone.sync();
    s2.down = false;
    s1.down = true;
    pc.put("a.md", "pc");
    await pc.sync();
    expect(s1.head()).not.toBe(s2.head());
    s1.down = false;
    const r = await pc.sync();
    expect(r.conflicts).toHaveLength(1);
    allAt(pc, r.head);
    const r2 = await phone.sync();
    expect(r2.head).toBe(r.head);
    expect(phone.files()).toEqual(pc.files());
    const texts = Object.values(pc.files()).sort();
    expect(texts).toEqual(["pc", "phone"].sort());
  });

  it("does not create a new vault while a host is unreachable", async () => {
    s2.down = true;
    const pc = mk("PC");
    pc.put("a.md", "1");
    await expect(pc.sync()).rejects.toThrow(/can't be reached/);
    expect(s1.head()).toBeNull();
  });

  it("works with one host down from the start for a joining device", async () => {
    const pc = mk("PC");
    pc.put("a.md", "1");
    await pc.sync();
    s1.down = true;
    const phone = mk("Phone");
    await phone.sync();
    expect(phone.file("a.md")).toBe("1");
  });
});

describe("safety", () => {
  it("wrong password gives a clear error and changes nothing", async () => {
    const pc = mk("PC");
    pc.put("a.md", "1");
    await pc.sync();
    const before = [s1.head(), s2.head()];
    const thief = mk("Other", { password: "nope" });
    thief.put("b.md", "x");
    await expect(thief.sync()).rejects.toBeInstanceOf(WrongPasswordError);
    expect([s1.head(), s2.head()]).toEqual(before);
    expect(thief.files()).toEqual({ "b.md": "x" });
  });

  it("refuses to mix two different vaults", async () => {
    const pc = mk("PC");
    pc.put("a.md", "1");
    await pc.sync();
    const s3 = new GitServer(path.join(tmp, "s3"));
    s3.createRepo();
    await s3.start();
    try {
      const other = new Device("Other", path.join(tmp, "other"), { servers: [s3] });
      other.put("z.md", "other vault");
      await other.sync();
      const s3head = s3.head();
      pc.servers = [s1, s2, s3];
      const r = await pc.sync();
      const st = r.remotes.find((x) => x.name === "server2")!;
      expect(st.problem).toBe("mismatch");
      expect(s3.head()).toBe(s3head);
      expect(pc.file("z.md")).toBeNull();
    } finally {
      await s3.stop();
    }
  });

  it("refuses a repository with unrelated content", async () => {
    const work = path.join(tmp, "work");
    execFileSync("git", ["init", "-q", "-b", "main", work]);
    fs.writeFileSync(path.join(work, "README"), "hi");
    execFileSync("git", ["-C", work, "add", "."]);
    execFileSync("git", ["-C", work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "x"]);
    execFileSync("git", ["-C", work, "push", "-q", path.join(tmp, "s2", "vault.git"), "main"]);
    const pc = mk("PC");
    pc.put("a.md", "1");
    const r = await pc.sync();
    expect(r.remotes.find((x) => x.name === "server1")!.problem).toBe("mismatch");
    expect(s1.head()).toBe(r.head);
  });

  it("password change keeps working everywhere", async () => {
    const pc = mk("PC", { password: "old" });
    const phone = mk("Phone", { password: "old" });
    pc.put("a.md", "1");
    await pc.sync();
    await phone.sync();
    await pc.engine.changePassword("new");
    // Phone stays unlocked (same vault key) and keeps syncing.
    phone.put("b.md", "2");
    await phone.sync();
    await pc.sync();
    expect(pc.file("b.md")).toBe("2");
    // A new device needs the new password.
    const tablet = mk("Tablet", { password: "old" });
    await expect(tablet.sync()).rejects.toBeInstanceOf(WrongPasswordError);
    tablet.password = "new";
    await tablet.sync();
    expect(tablet.files()).toEqual(pc.files());
  });

  it("keeps the repo free of readable names, text and device names", async () => {
    const pc = mk("MyLaptopName");
    pc.put("Secret Folder/Diary entry.md", "dear diary, my bank pin is 4711");
    pc.put("todo.txt", "buy milk");
    await pc.sync();
    pc.put("todo.txt", "buy milk and eggs");
    pc.engine;
    await pc.sync();
    const phone = mk("PhoneOfRick");
    await phone.sync();
    pc.put("todo.txt", "conflicting A");
    phone.put("todo.txt", "conflicting B");
    await pc.sync();
    await phone.sync();
    for (const s of ["s1", "s2"]) {
      const dir = path.join(tmp, s, "vault.git");
      const all = execFileSync("git", ["-C", dir, "cat-file", "--batch-all-objects", "--batch"], { maxBuffer: 1 << 28 });
      const text = all.toString("latin1");
      for (const needle of ["Secret", "Diary", "diary", "4711", "milk", "todo", "MyLaptop", "PhoneOfRick", "conflict", ".md", ".txt"]) {
        expect(text.includes(needle), `found "${needle}" in ${s}`).toBe(false);
      }
      const log = execFileSync("git", ["-C", dir, "log", "--format=%an|%ae|%cn|%ce|%s"]).toString();
      expect(new Set(log.trim().split("\n"))).toEqual(new Set(["encgidian|sync@invalid|encgidian|sync@invalid|sync"]));
    }
  });
});

describe("names", () => {
  it("names that differ only by case get (n)", async () => {
    const pc = mk("PC");
    const phone = mk("Phone");
    await pc.sync();
    await phone.sync();
    pc.put("Note.md", "from pc");
    phone.put("note.md", "from phone");
    await pc.sync();
    const r = await phone.sync();
    await pc.sync();
    expect(r.clashes).toEqual([{ from: "note.md", to: "note (1).md" }]);
    expect(phone.files()).toEqual({ "Note.md": "from pc", "note (1).md": "from phone" });
    expect(pc.files()).toEqual(phone.files());
  });

  it("renames files with names Windows can't hold", async () => {
    const pc = mk("PC");
    pc.put("a:b?.md", "x");
    pc.put("a_b_.md", "y");
    const r = await pc.sync();
    expect(r.renamedLocal).toEqual([{ from: "a:b?.md", to: "a_b_ (1).md" }]);
    expect(pc.files()).toEqual({ "a_b_.md": "y", "a_b_ (1).md": "x" });
  });
});

describe("filters", () => {
  it("a device that ignores a folder neither gets nor deletes it", async () => {
    const pc = mk("PC");
    const phone = mk("Phone", { options: { ignoredFolders: ["Big"], maxFileSize: 10 } });
    pc.put("Big/video.md", "v");
    pc.put("large.md", "0123456789ABCDEF");
    pc.put("small.md", "s");
    await pc.sync();
    await phone.sync();
    expect(phone.files()).toEqual({ "small.md": "s" });
    phone.put("small.md", "s2");
    await phone.sync();
    await pc.sync();
    expect(pc.files()).toEqual({ "Big/video.md": "v", "large.md": "0123456789ABCDEF", "small.md": "s2" });
  });

  it("does not sync the config folder unless asked, and never the plugin folder", async () => {
    const pc = mk("PC", { options: { syncConfigDir: true } });
    pc.put(".obsidian/app.json", "{}");
    pc.put(".obsidian/workspace.json", "layout");
    pc.put(".obsidian/plugins/encgidian/data.json", "secret settings");
    await pc.sync();
    const phone = mk("Phone", { options: { syncConfigDir: true } });
    await phone.sync();
    expect(phone.files()).toEqual({ ".obsidian/app.json": "{}" });
    const laptop = mk("Laptop");
    await laptop.sync();
    expect(laptop.files()).toEqual({});
  });
});

describe("history", () => {
  it("lists older versions and deleted files, and reads them back", async () => {
    const { fileVersions, deletedFiles, readEntry } = await import("../src/core/history");
    const { fromUtf8 } = await import("../src/core/bytes");
    const pc = mk("PC");
    pc.put("n.md", "v1");
    pc.put("gone.md", "bye");
    await pc.sync();
    pc.put("n.md", "v2");
    await pc.sync();
    pc.put("n.md", "v3");
    pc.del("gone.md");
    await pc.sync();
    const keys = await (pc.engine as any).d.keys.unlock((await pc.repo.keyFileAt((await pc.repo.head())!))!.keyFile);
    const head = (await pc.repo.head())!;
    const vs = await fileVersions(pc.repo, keys, head, "n.md");
    expect(await Promise.all(vs.map(async (v) => fromUtf8(await readEntry(pc.repo, keys, v.entry))))).toEqual(["v3", "v2", "v1"]);
    const del = await deletedFiles(pc.repo, keys, head);
    expect(del.map((d) => d.path)).toEqual(["gone.md"]);
    expect(fromUtf8(await readEntry(pc.repo, keys, del[0].last.entry))).toBe("bye");
  });
});

describe("edits during a sync", () => {
  it("a file edited while the sync runs is kept, the incoming version saved beside it", async () => {
    const pc = mk("PC");
    const phone = mk("Phone");
    pc.put("a.md", "1");
    await pc.sync();
    await phone.sync();
    pc.put("a.md", "2");
    await pc.sync();
    // Edit the note after the sync has checked it but before it writes the incoming version.
    const origList = phone.vault.list.bind(phone.vault);
    const origRead = phone.repo.readBlob.bind(phone.repo);
    let scanned = false;
    let once = true;
    phone.vault.list = async () => {
      scanned = true;
      return origList();
    };
    phone.repo.readBlob = async (oid: string) => {
      const b = await origRead(oid);
      if (scanned && once && Buffer.from(b.subarray(0, 4)).toString() === "EGO1") {
        once = false;
        phone.put("a.md", "typed during sync", Date.now() + 5000);
      }
      return b;
    };
    const r = await phone.sync();
    expect(r.lateConflicts).toHaveLength(1);
    expect(phone.file("a.md")).toBe("typed during sync");
    expect(phone.file(r.lateConflicts[0].copy)).toBe("2");
    phone.vault.list = origList;
    phone.repo.readBlob = origRead;
    await phone.sync();
    await pc.sync();
    expect(pc.files()).toEqual(phone.files());
    expect(Object.values(pc.files()).sort()).toEqual(["2", "typed during sync"]);
  });
});

describe("failed deletes", () => {
  it("a delete that silently fails stops the sync instead of resurrecting the file", async () => {
    const pc = mk("PC");
    const phone = mk("Phone");
    pc.put("x.md", "1");
    await pc.sync();
    await phone.sync();
    phone.del("x.md");
    await phone.sync();
    const realRemove = pc.vault.remove.bind(pc.vault);
    pc.vault.remove = async () => {}; // e.g. the system trash refused
    await expect(pc.sync()).rejects.toThrow(/Couldn't delete "x.md"/);
    await phone.sync();
    expect(phone.file("x.md")).toBeNull();
    pc.vault.remove = realRemove;
    await pc.sync();
    await phone.sync();
    expect(pc.file("x.md")).toBeNull();
    expect(phone.file("x.md")).toBeNull();
  });
});

describe("version list", () => {
  it("shows re-encrypted copies of the same content once", async () => {
    const { fileVersions } = await import("../src/core/history");
    const pc = mk("PC");
    pc.put("n.md", "A");
    await pc.sync();
    pc.mv("n.md", "tmp.md"); // rename away and back: same content, new encryption
    await pc.sync();
    pc.mv("tmp.md", "n.md");
    await pc.sync();
    pc.put("n.md", "B");
    await pc.sync();
    const head = (await pc.repo.head())!;
    const keys = await (pc.engine as any).d.keys.unlock((await pc.repo.keyFileAt(head))!.keyFile);
    const vs = await fileVersions(pc.repo, keys, head, "n.md");
    expect(vs).toHaveLength(2);
  });
});

describe("replacing a host's unrelated content", () => {
  const readmeRepo = (server: string) => {
    const work = path.join(tmp, "readme-" + server);
    execFileSync("git", ["init", "-q", "-b", "main", work]);
    fs.writeFileSync(path.join(work, "README.md"), "# starter readme");
    execFileSync("git", ["-C", work, "add", "."]);
    execFileSync("git", ["-C", work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
    execFileSync("git", ["-C", work, "push", "-q", path.join(tmp, server, "vault.git"), "main"]);
  };

  it("replaces a README-only repo after confirmation, then syncs it like any host", async () => {
    readmeRepo("s2");
    const pc = mk("PC");
    pc.put("a.md", "1");
    const r1 = await pc.sync();
    expect(r1.remotes[1].problem).toBe("mismatch");
    expect(r1.remotes[1].error).toMatch(/Replace with this vault/);
    const ep = (pc.engine as any).d.endpoints()[1];
    const info = await pc.engine.inspectForReplace(ep);
    expect(info.commits).toBe(1);
    const r2 = await pc.engine.replaceHost(ep, info.head);
    allAt(pc, r2.head);
    const phone = mk("Phone");
    phone.servers = [s2];
    await phone.sync();
    expect(phone.file("a.md")).toBe("1");
  });

  it("never replaces an encrypted vault, or a repo that changed after the check", async () => {
    const pc = mk("PC");
    pc.put("a.md", "1");
    await pc.sync();
    const ep = (pc.engine as any).d.endpoints()[0];
    await expect(pc.engine.inspectForReplace(ep)).rejects.toThrow(/holds an encrypted vault/);
  });

  it("refuses when the repo changed after the check", async () => {
    readmeRepo("s2");
    const pc = mk("PC");
    pc.put("a.md", "1");
    await pc.sync();
    const ep = (pc.engine as any).d.endpoints()[1];
    const info = await pc.engine.inspectForReplace(ep);
    const work = path.join(tmp, "readme-s2");
    fs.writeFileSync(path.join(work, "more.md"), "someone pushed");
    execFileSync("git", ["-C", work, "add", "."]);
    execFileSync("git", ["-C", work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "more"]);
    execFileSync("git", ["-C", work, "push", "-q", path.join(tmp, "s2", "vault.git"), "main"]);
    await expect(pc.engine.replaceHost(ep, info.head)).rejects.toThrow(/changed since you checked/);
  });
});

describe("unreliable writes on the device", () => {
  it("retries writes that come out empty, so every file is complete", async () => {
    const pc = mk("PC");
    for (let i = 0; i < 40; i++) pc.put(`n/${i}.md`, `note ${i}`);
    await pc.sync();
    const phone = mk("Phone");
    const real = phone.vault.write.bind(phone.vault);
    let broken = 0;
    const seen = new Set<string>();
    phone.vault.write = async (p, data, mtime) => {
      // Like Obsidian for Android: a write sometimes leaves an empty file. Here: the
      // first write of every third file.
      if (!seen.has(p) && seen.size % 3 === 0) {
        seen.add(p);
        broken++;
        return real(p, new Uint8Array(0), mtime);
      }
      seen.add(p);
      return real(p, data, mtime);
    };
    await phone.sync();
    expect(broken).toBeGreaterThan(0);
    for (let i = 0; i < 40; i++) expect(phone.file(`n/${i}.md`)).toBe(`note ${i}`);
  });

  it("stops instead of recording a write that never succeeds", async () => {
    const pc = mk("PC");
    pc.put("a.md", "content");
    await pc.sync();
    const phone = mk("Phone");
    const real = phone.vault.write.bind(phone.vault);
    phone.vault.write = async (p, _d, m) => real(p, new Uint8Array(0), m);
    await expect(phone.sync()).rejects.toThrow(/Couldn't write "a.md" on this device/);
    phone.vault.write = real;
    await phone.sync();
    expect(phone.file("a.md")).toBe("content");
  });

  it("repairs a file left empty by an earlier version, without uploading the empty file", async () => {
    const pc = mk("PC");
    pc.put("a.md", "precious content");
    await pc.sync();
    const phone = mk("Phone");
    await phone.sync();
    // Simulate the old bug: file emptied on disk, and the state recorded that empty size as correct.
    fs.writeFileSync(path.join(phone.vaultDir, "a.md"), "");
    const st = fs.statSync(path.join(phone.vaultDir, "a.md"));
    const stateFile = path.join(phone.root, "state.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    state.files["a.md"] = { ...state.files["a.md"], s: 0, t: Math.floor(st.mtimeMs) };
    fs.writeFileSync(stateFile, JSON.stringify(state));
    const r = await phone.sync();
    expect(r.repaired).toEqual(["a.md"]);
    expect(r.committedLocal).toBe(false);
    expect(phone.file("a.md")).toBe("precious content");
    await pc.sync();
    expect(pc.file("a.md")).toBe("precious content");
  });
});

describe("damaged local Git repo", () => {
  it("repo writes that come out empty are retried", { timeout: 60000 }, async () => {
    let broken = 0;
    const seenObj = new Set<string>();
    const flaky = {
      promises: {
        ...fs.promises,
        writeFile: async (p: string, d: any, ...r: any[]) => {
          // First write of every fifth object comes out empty.
          if (/objects\/[0-9a-f]{2}\//.test(p) && !seenObj.has(p) && seenObj.size % 5 === 0) {
            seenObj.add(p);
            broken++;
            return fs.promises.writeFile(p, new Uint8Array(0));
          }
          seenObj.add(p);
          return (fs.promises.writeFile as any)(p, d, ...r);
        },
      },
    };
    const pc = mk("PC", { repoFs: flaky } as any);
    for (let i = 0; i < 30; i++) pc.put(`n${i}.md`, `note ${i}`);
    await pc.sync();
    pc.put("n1.md", "changed");
    await pc.sync();
    expect(broken).toBeGreaterThan(0);
    const phone = mk("Phone");
    await phone.sync();
    expect(phone.file("n1.md")).toBe("changed");
    expect(phone.file("n29.md")).toBe("note 29");
  });

  it("a repo with an empty object repairs itself from a host and keeps local edits", async () => {
    const pc = mk("PC");
    const phone = mk("Phone");
    pc.put("a.md", "1");
    await pc.sync();
    await phone.sync();
    // Phone works offline: local commit only.
    s1.down = true;
    s2.down = true;
    phone.put("a.md", "offline edit");
    phone.put("new.md", "written offline");
    await phone.sync();
    s1.down = false;
    s2.down = false;
    // Damage one object of that offline commit, like Obsidian for Android did.
    const head = (await phone.repo.head())!;
    const { execFileSync: x } = await import("child_process");
    const tree = x("git", ["--git-dir", phone.repo.gitdir, "cat-file", "-p", head]).toString().match(/^tree (\w+)/)![1];
    const f = path.join(phone.repo.gitdir, "objects", tree.slice(0, 2), tree.slice(2));
    fs.chmodSync(f, 0o644);
    fs.writeFileSync(f, "");
    // Meanwhile the PC edits something else.
    pc.put("pc.md", "from pc");
    await pc.sync();
    const r = await phone.sync();
    expect(r.repoRepaired).toBe(true);
    expect(r.remotes.every((x) => x.upToDate)).toBe(true);
    await pc.sync();
    expect(pc.files()).toEqual({ "a.md": "offline edit", "new.md": "written offline", "pc.md": "from pc" });
    expect(phone.files()).toEqual(pc.files());
  });
});

describe("bounded transfers (Obsidian for Android can't take big downloads)", { timeout: 180000 }, () => {
  const MB = 1024 * 1024;
  const randomText = (n: number) => require("crypto").randomBytes(n).toString("base64").slice(0, n);

  it("a large initial upload and a fresh device's download happen in pieces of about 8 MB", async () => {
    const upT = { maxDown: 0, maxUp: 0, requests: 0 };
    const pc = mk("PC", { traffic: upT } as any);
    for (let i = 0; i < 300; i++) pc.put(`img/${String(i).padStart(3, "0")}.md`, randomText(100 * 1024)); // ~40 MB once encrypted
    const r = await pc.sync();
    expect(r.remotes.every((x) => x.upToDate)).toBe(true);
    const steps = execFileSync("git", ["-C", path.join(tmp, "s1", "vault.git"), "for-each-ref", "refs/encgidian/steps/"]).toString().trim().split("\n");
    expect(steps.length).toBeGreaterThanOrEqual(3);
    expect(upT.maxUp).toBeLessThan(12 * MB);

    const downT = { maxDown: 0, maxUp: 0, requests: 0 };
    const phone = mk("Phone", { traffic: downT } as any);
    await phone.sync();
    expect(downT.maxDown).toBeLessThan(12 * MB);
    expect(Object.keys(phone.files())).toHaveLength(300);
    expect(phone.file("img/123.md")).toBe(pc.file("img/123.md"));
  });

  it("a device that is far behind catches up in pieces too", async () => {
    const pc = mk("PC");
    const phone = mk("Phone");
    pc.put("a.md", "1");
    await pc.sync();
    await phone.sync();
    for (let round = 0; round < 6; round++) {
      for (let i = 0; i < 30; i++) pc.put(`r${round}/${i}.md`, randomText(100 * 1024)); // ~4 MB per sync
      await pc.sync();
    }
    const t = { maxDown: 0, maxUp: 0, requests: 0 };
    const phone2 = new Device("Phone", phone.root, { servers: [s1, s2], traffic: t } as any);
    await phone2.sync();
    expect(t.maxDown).toBeLessThan(12 * MB);
    expect(Object.keys(phone2.files())).toHaveLength(181);
  });

  it("large files live outside main; a device with a small size limit never downloads them", async () => {
    const pc = mk("PC");
    const big = require("crypto").randomBytes(10 * MB);
    fs.mkdirSync(path.join(pc.vaultDir, "media"), { recursive: true });
    fs.writeFileSync(path.join(pc.vaultDir, "media", "video.bin"), big);
    pc.put("note.md", "small");
    await pc.sync();
    const refs = execFileSync("git", ["-C", path.join(tmp, "s1", "vault.git"), "for-each-ref", "refs/encgidian/large/"]).toString().trim().split("\n");
    expect(refs).toHaveLength(1);

    const t = { maxDown: 0, maxUp: 0, requests: 0 };
    const phone = mk("Phone", { traffic: t, options: { maxFileSize: 5 * MB } } as any);
    await phone.sync();
    expect(phone.file("note.md")).toBe("small");
    expect(phone.file("media/video.bin")).toBeNull();
    expect(t.maxDown).toBeLessThan(1 * MB); // the 10 MB file was never downloaded
    phone.put("note.md", "edited on phone");
    await phone.sync(); // and its absence is not a delete
    await pc.sync();
    expect(fs.readFileSync(path.join(pc.vaultDir, "media", "video.bin")).equals(big)).toBe(true);
    expect(pc.file("note.md")).toBe("edited on phone");

    const laptop = mk("Laptop"); // no size limit: downloads it on demand
    await laptop.sync();
    expect(fs.readFileSync(path.join(laptop.vaultDir, "media", "video.bin")).equals(big)).toBe(true);
  });

  it("a new empty host is filled in bounded pieces, including large files", async () => {
    const pc = mk("PC");
    for (let i = 0; i < 200; i++) pc.put(`n/${i}.md`, randomText(100 * 1024));
    fs.writeFileSync(path.join(pc.vaultDir, "big.bin"), require("crypto").randomBytes(9 * MB));
    pc.servers = [s1];
    await pc.sync();
    const s3 = new GitServer(path.join(tmp, "s3"));
    s3.createRepo();
    await s3.start();
    try {
      const t = { maxDown: 0, maxUp: 0, requests: 0 };
      const pc2 = new Device("PC", pc.root, { servers: [s1, s3], traffic: t } as any);
      const r = await pc2.sync();
      expect(r.remotes.every((x) => x.upToDate)).toBe(true);
      expect(t.maxUp).toBeLessThan(12 * MB);
      const phone = new Device("Phone", path.join(tmp, "phone3"), { servers: [s3] });
      await phone.sync();
      expect(Object.keys(phone.files())).toHaveLength(201);
    } finally {
      await s3.stop();
    }
  });
});

describe("compaction", { timeout: 120000 }, () => {
  it("packs many small files and packs into a few, keeping everything readable and in sync", async () => {
    const pc = mk("PC");
    const phone = mk("Phone");
    for (let i = 0; i < 50; i++) pc.put(`n/${i}.md`, `note ${i}`);
    await pc.sync();
    await phone.sync();
    for (let i = 0; i < 40; i++) {
      pc.put(`n/${i % 50}.md`, `edit ${i}`, Date.now() + i);
      await pc.sync();
      await phone.sync(); // one new pack per round on the phone
    }
    const packsBefore = await phone.repo.packCount();
    expect(packsBefore).toBeGreaterThan(3); // (automatic compaction may already have run once)
    const r = await phone.repo.compact(64 * 1024);
    expect(r.packsAfter).toBeLessThan(packsBefore);
    const looseLeft = fs.readdirSync(path.join(phone.repo.gitdir, "objects")).filter((d) => /^[0-9a-f]{2}$/.test(d)).length;
    expect(looseLeft).toBe(0);
    execFileSync("git", ["--git-dir", phone.repo.gitdir, "fsck", "--full"]); // throws if anything is missing
    // History still readable, and syncing still works both ways.
    const { fileVersions } = await import("../src/core/history");
    const keys = await (phone.engine as any).d.keys.unlock((await phone.repo.keyFileAt((await phone.repo.head())!))!.keyFile);
    expect((await fileVersions(phone.repo, keys, (await phone.repo.head())!, "n/0.md")).length).toBeGreaterThan(1);
    phone.put("from-phone.md", "after compaction");
    await phone.sync();
    await pc.sync();
    expect(pc.file("from-phone.md")).toBe("after compaction");
    expect(pc.files()).toEqual(phone.files());
  });

  it("runs by itself when packs pile up", async () => {
    const pc = mk("PC");
    const phone = mk("Phone");
    pc.put("a.md", "0");
    await pc.sync();
    await phone.sync();
    let compacted = false;
    for (let i = 1; i <= 35 && !compacted; i++) {
      pc.put("a.md", String(i), Date.now() + i);
      await pc.sync();
      compacted = !!(await phone.sync()).compacted;
    }
    expect(compacted).toBe(true);
    expect(await phone.repo.packCount()).toBeLessThan(5);
  });
});
