// A private sshd for tests, running as the current user on a random port.

import { ChildProcess, execFileSync, spawn } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import * as os from "os";

async function freePort(): Promise<number> {
  return new Promise((r) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => r(p));
    });
  });
}

export class SshServer {
  port = 0;
  private proc?: ChildProcess;
  constructor(readonly dir: string) {}

  /** Start sshd that accepts `pubKey`. Repos live in `this.dir/repos`. */
  async start(pubKey: string): Promise<void> {
    fs.mkdirSync(path.join(this.dir, "repos"), { recursive: true });
    const hostKey = path.join(this.dir, "host_ed25519");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostKey]);
    const auth = path.join(this.dir, "authorized_keys");
    fs.writeFileSync(auth, pubKey + "\n", { mode: 0o600 });
    this.port = await freePort();
    const cfg = path.join(this.dir, "sshd_config");
    fs.writeFileSync(
      cfg,
      [
        `Port ${this.port}`,
        "ListenAddress 127.0.0.1",
        `HostKey ${hostKey}`,
        `AuthorizedKeysFile ${auth}`,
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        "PubkeyAuthentication yes",
        "UsePAM no",
        "StrictModes no",
        `PidFile ${path.join(this.dir, "sshd.pid")}`,
        `SetEnv PATH=${process.env.PATH}`,
      ].join("\n") + "\n",
    );
    this.proc = spawn("/usr/bin/sshd", ["-D", "-e", "-f", cfg], { stdio: ["ignore", "ignore", "pipe"] });
    let log = "";
    this.proc.stderr!.on("data", (d) => (log += d));
    for (let i = 0; i < 50; i++) {
      const ok = await new Promise<boolean>((r) => {
        const s = net.connect(this.port, "127.0.0.1", () => {
          s.destroy();
          r(true);
        });
        s.on("error", () => r(false));
      });
      if (ok) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("sshd did not start: " + log);
  }

  createRepo(name = "vault"): string {
    const d = path.join(this.dir, "repos", `${name}.git`);
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", d]);
    return d;
  }

  url(name = "vault"): string {
    return `ssh://${os.userInfo().username}@127.0.0.1:${this.port}${path.join(this.dir, "repos", `${name}.git`)}`;
  }

  head(name = "vault"): string | null {
    try {
      return execFileSync("git", ["-C", path.join(this.dir, "repos", `${name}.git`), "rev-parse", "--verify", "-q", "refs/heads/main"]).toString().trim();
    } catch {
      return null;
    }
  }

  stop() {
    this.proc?.kill();
  }
}
