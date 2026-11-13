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
