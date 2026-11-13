import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { GitServer } from "./helpers/gitserver";
import { Device } from "./helpers/device";
import { SshServer } from "./helpers/sshserver";
import { HttpProxy, Socks5Proxy } from "./helpers/proxies";
import { CliTransport, generateSshKey, sshCommand } from "../src/platform/git-cli";
import { checkUrlSafety, Endpoint, IsoTransport, isSshUrl, scrub } from "../src/core/transport";
import { makeNodeHttp } from "../src/platform/http-node";
import { Repo } from "../src/core/repo";

// Proxies must apply even to 127.0.0.1 in these tests.
for (const k of ["NO_PROXY", "no_proxy", "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) delete process.env[k];

let tmp: string;
let devices: Device[] = [];
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "egt-"));
  devices = [];
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Files under dir containing text ("" when none). */
function grepFor(text: string, dir: string): string {
  try {
    return execFileSync("grep", ["-rlF", text, dir], { encoding: "utf8" });
  } catch {
    return ""; // grep exits 1 when nothing matches
  }
}

const TOKEN = "tok-SECRET-9f8e7d6c";
const PASSPHRASE = "ssh pass PHRASE-42";

describe("URL and secret hygiene", () => {
  it("only sends credentials over https, ssh or to this machine", () => {
    expect(() => checkUrlSafety("http://example.com/x.git", true)).toThrow(/Refusing/);
    expect(() => checkUrlSafety("http://127.0.0.1:9/x.git", true)).not.toThrow();
    expect(() => checkUrlSafety("https://example.com/x.git", true)).not.toThrow();
    expect(() => checkUrlSafety("git@github.com:me/x.git", true)).not.toThrow();
    expect(() => checkUrlSafety("https://me:pw@example.com/x.git", true)).toThrow(/not in the URL/);
    expect(isSshUrl("git@github.com:me/x.git")).toBe(true);
    expect(isSshUrl("ssh://git@host:22/x.git")).toBe(true);
    expect(isSshUrl("https://github.com/me/x.git")).toBe(false);
  });

  it("scrubs secrets from messages", () => {
    expect(scrub(`fatal: https://u:${TOKEN}@host failed ${TOKEN}`, { password: TOKEN })).not.toContain(TOKEN);
  });

  it("builds ssh proxy commands per platform", () => {
    const o = { helperDir: "/h", proxy: "socks5://127.0.0.1:1080" };
    expect(sshCommand(undefined, o, false)).toContain("ProxyCommand=nc -X 5 -x 127.0.0.1:1080 %h %p");
    expect(sshCommand(undefined, { ...o, proxy: "http://p:3128" }, true)).toContain("ProxyCommand=connect -H p:3128 %h %p");
  });
});

describe("token sign-in over HTTPS-style Basic auth", () => {
  let s: GitServer;
  beforeEach(async () => {
    s = new GitServer(path.join(tmp, "auth"));
    s.createRepo();
    s.auth = { username: "x-access-token", password: TOKEN };
    await s.start();
  });
  afterEach(() => s.stop());

  for (const engine of ["builtin", "system"] as const) {
    it(`${engine} engine: right token works, wrong token is reported as a sign-in problem`, async () => {
      const transport = (repo: Repo) =>
        engine === "builtin" ? new IsoTransport(repo, makeNodeHttp()) : new CliTransport(repo, { helperDir: path.join(tmp, "h") });
      const good = new Device("A", path.join(tmp, "A"), { servers: [s], creds: { password: TOKEN }, transport });
      good.put("a.md", "1");
      const r = await good.sync();
      expect(r.remotes[0].upToDate).toBe(true);
      expect(s.head()).toBe(r.head);

      const bad = new Device("B", path.join(tmp, "B"), { servers: [s], creds: { password: "wrong-token" }, transport });
      await expect(bad.sync()).rejects.toThrow(/Sign-in|sign-in|denied|401|403/);

      // No secret ends up in the local repo, its config, or the state file.
      expect(grepFor(TOKEN, path.join(tmp, "A"))).toBe("");
    });
  }
});

describe("SSH (system Git)", () => {
  let ssh: SshServer;
  let http: GitServer;
  let keyFile: string;
  const helperDir = () => path.join(tmp, "helper");

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "egs-"));
    keyFile = path.join(dir, "key", "id_ed25519");
    const pub = await generateSshKey(path.join(dir, "kg"), keyFile, PASSPHRASE);
    expect(pub).toMatch(/^ssh-ed25519 /);
    ssh = new SshServer(path.join(dir, "sshd"));
    await ssh.start(pub);
  });
  afterAll(() => ssh.stop());
  beforeEach(async () => {
    fs.rmSync(path.join(ssh.dir, "repos"), { recursive: true, force: true });
    ssh.createRepo();
    http = new GitServer(path.join(tmp, "http"));
    http.createRepo();
    await http.start();
  });
  afterEach(() => http.stop());

  const mkDev = (name: string, passphrase = PASSPHRASE, proxy?: string) =>
    new Device(name, path.join(tmp, name), {
      servers: [ssh, http],
      creds: (url) => (isSshUrl(url) ? { sshKeyPath: keyFile, sshPassphrase: passphrase } : undefined),
      transport: (repo: Repo, ep: Endpoint) =>
        isSshUrl(ep.url) ? new CliTransport(repo, { helperDir: path.join(helperDir(), name), proxy }) : new IsoTransport(repo, makeNodeHttp()),
    });

  it("syncs through an SSH host and an HTTPS host together", async () => {
    const a = mkDev("A");
    a.put("note.md", "over ssh");
    const r = await a.sync();
    expect(r.remotes.every((x) => x.upToDate)).toBe(true);
    expect(ssh.head()).toBe(r.head);
    expect(http.head()).toBe(r.head);
    const b = mkDev("B");
    b.servers = [ssh]; // only SSH
    await b.sync();
    expect(b.file("note.md")).toBe("over ssh");
    b.put("note.md", "edited on B");
    await b.sync();
    const r2 = await a.sync();
    expect(a.file("note.md")).toBe("edited on B");
    expect(http.head()).toBe(r2.head); // A forwarded B's commit to the HTTPS host
  });

  it("a wrong key passphrase is a sign-in problem and doesn't stop the other host", async () => {
    const a = mkDev("A");
    a.put("x.md", "1");
    await a.sync();
    const b = mkDev("B", "wrong passphrase");
    const r = await b.sync();
    const st = r.remotes.find((x) => x.url.startsWith("ssh://"))!;
    expect(st.problem).toBe("auth");
    expect(b.file("x.md")).toBe("1");
  });

  it("goes through a SOCKS5 proxy", async () => {
    const p = new Socks5Proxy();
    await p.start();
    try {
      const a = mkDev("A", PASSPHRASE, p.url());
      a.put("p.md", "via proxy");
      const r = await a.sync();
      expect(r.remotes.find((x) => x.url.startsWith("ssh://"))!.upToDate).toBe(true);
      expect(p.used).toBeGreaterThan(0);
    } finally {
      await p.stop();
    }
  });

  it("never leaves the passphrase on disk", async () => {
    const a = mkDev("A");
    a.put("x.md", "1");
    await a.sync();
    expect(grepFor(PASSPHRASE, tmp)).toBe("");
  });
});

describe("proxies for HTTPS hosts", () => {
  let s: GitServer;
  beforeEach(async () => {
    s = new GitServer(path.join(tmp, "s"));
    s.createRepo();
    await s.start();
  });
  afterEach(() => s.stop());

  const cases = [
    ["builtin", "http"],
    ["builtin", "socks5"],
    ["system", "http"],
    ["system", "socks5"],
  ] as const;
  for (const [engine, kind] of cases) {
    it(`${engine} engine through ${kind} proxy`, async () => {
      const p = kind === "http" ? new HttpProxy() : new Socks5Proxy();
      await p.start();
      try {
        const transport = (repo: Repo) =>
          engine === "builtin"
            ? new IsoTransport(repo, makeNodeHttp({ proxy: p.url() }))
            : new CliTransport(repo, { helperDir: path.join(tmp, "h"), proxy: p.url() });
        const a = new Device("A", path.join(tmp, "A"), { servers: [s], transport });
        a.put("a.md", "1");
        const r = await a.sync();
        expect(r.remotes[0].upToDate).toBe(true);
        expect(s.head()).toBe(r.head);
        expect(p.used).toBeGreaterThan(0);
      } finally {
        await p.stop();
      }
    });
  }
});
