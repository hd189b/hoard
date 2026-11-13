import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile, execFileSync } from "child_process";
import { promisify } from "util";
const run = promisify(execFile);
import { GitServer } from "./helpers/gitserver";
import { Device } from "./helpers/device";
import { VaultReader } from "../src/decrypter/reader";
import { startServer } from "../src/decrypter/server";
import { formatRecoveryKey, WrongPasswordError } from "../src/core/keys";
import { fromUtf8 } from "../src/core/bytes";

let tmp: string;
let s: GitServer;
let clone: string;
let bare: string;
let recovery: string;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "egdec-"));
  s = new GitServer(path.join(tmp, "s"));
  s.createRepo();
  await s.start();
  const pc = new Device("PC", path.join(tmp, "pc"), { servers: [s], password: "hunter2-long" });
  pc.put("Notes/Plan.md", "v1");
  pc.put("pic.png", "\x89PNG fake");
  pc.put("old.md", "to be deleted");
  await pc.sync();
  pc.put("Notes/Plan.md", "v2");
  await pc.sync();
  pc.put("Notes/Plan.md", "v3");
  pc.del("old.md");
  await pc.sync();
  const head = (await pc.repo.head())!;
  const keys = await (pc.engine as any).d.keys.unlock((await pc.repo.keyFileAt(head))!.keyFile);
  recovery = formatRecoveryKey(keys);
  clone = path.join(tmp, "clone");
  bare = path.join(tmp, "bare.git");
  // async: the test Git server runs in this process
  await run("git", ["clone", "-q", s.url(), clone]);
  await run("git", ["clone", "-q", "--bare", s.url(), bare]);
});
afterAll(async () => {
  await s.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("decrypter", () => {
  it("opens normal and bare clones, refuses a wrong password", async () => {
    for (const dir of [clone, bare]) {
      const r = await VaultReader.open(dir);
      await expect(r.unlockPassword("nope")).rejects.toBeInstanceOf(WrongPasswordError);
      await r.unlockPassword("hunter2-long");
      const m = await r.snapshot(await r.resolveCommit());
      expect([...m.keys()].sort()).toEqual(["Notes/Plan.md", "pic.png"]);
    }
  });

  it("reads every version, deleted files, and older syncs; never changes the repo", async () => {
    const before = execFileSync("git", ["-C", bare, "count-objects", "-v"]).toString() + fs.readdirSync(path.join(bare, "refs", "heads")).join();
    const r = await VaultReader.open(bare);
    await r.unlockRecoveryKey(recovery);
    const vs = await r.versions("Notes/Plan.md");
    expect(await Promise.all(vs.map(async (v) => fromUtf8(await r.readObject(v.entry))))).toEqual(["v3", "v2", "v1"]);
    const del = await r.deleted();
    expect(del.map((d) => d.path)).toEqual(["old.md"]);
    const commits = await r.commits();
    const oldest = commits[commits.length - 1].oid;
    expect(fromUtf8((await r.read(await r.resolveCommit(oldest.slice(0, 8)), "old.md")).data)).toBe("to be deleted");
    const out = path.join(tmp, "export");
    expect(await r.exportTo(oldest, out)).toBe(3);
    expect(fs.readFileSync(path.join(out, "Notes", "Plan.md"), "utf8")).toBe("v1");
    const after = execFileSync("git", ["-C", bare, "count-objects", "-v"]).toString() + fs.readdirSync(path.join(bare, "refs", "heads")).join();
    expect(after).toBe(before);
  });

  it("web interface needs the token, refuses other host names, and serves files", async () => {
    const r = await VaultReader.open(clone);
    const srv = await startServer(r);
    try {
      const base = srv.url.split("/#")[0];
      const token = srv.url.split("#t=")[1];
      expect((await fetch(base + "/")).status).toBe(200);
      expect((await fetch(base + "/api/info")).status).toBe(401);
      const h = { "x-token": token, "content-type": "application/json" };
      expect((await fetch(base + "/api/snapshot", { headers: h })).status).toBe(423);
      expect((await fetch(base + "/api/unlock", { method: "POST", headers: h, body: JSON.stringify({ password: "bad" }) })).status).toBe(403);
      expect((await fetch(base + "/api/unlock", { method: "POST", headers: h, body: JSON.stringify({ password: "hunter2-long" }) })).status).toBe(200);
      const snap = await (await fetch(base + "/api/snapshot", { headers: h })).json();
      expect(snap.map((f: any) => f.path)).toEqual(["Notes/Plan.md", "pic.png"]);
      const raw = await fetch(base + "/api/raw?path=" + encodeURIComponent("Notes/Plan.md"), { headers: h });
      expect(await raw.text()).toBe("v3");
      expect(raw.headers.get("content-security-policy")).toBe("sandbox");
      const img = await fetch(base + "/api/raw?path=pic.png", { headers: h });
      expect(img.headers.get("content-type")).toBe("image/png");
      // DNS-rebinding style request with a foreign Host header
      const port = new URL(base).port;
      const foreign = (await run("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "-H", "Host: evil.example:" + port, "-H", "x-token: " + token, base + "/api/info"])).stdout;
      expect(foreign).toBe("403");
    } finally {
      await srv.close();
    }
  });
});
