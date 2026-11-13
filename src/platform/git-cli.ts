// System Git engine (desktop only): runs the installed `git` program.
// Needed for SSH remotes; also usable for HTTPS.
//
// Credentials never appear on the command line, in a URL or in Git config:
// they are given to a small askpass helper through the child's environment,
// and the user's own credential helpers are switched off for these calls.

import { spawn } from "child_process";
import { promises as fsp } from "fs";
import * as path from "path";
import { BRANCH } from "../core/format";
import { Repo } from "../core/repo";
import { AuthError, authProblem, checkUrlSafety, friendlyNetworkError, ProtectedBranchError, Credentials, Endpoint, isSshUrl, PushRejectedError, scrub, Transport } from "../core/transport";

export interface CliOptions {
  /** Path to git; default "git". */
  gitPath?: string;
  /** http://host:port or socks5://host:port */
  proxy?: string;
  /** Folder for the askpass helper and known_hosts (the plugin folder). */
  helperDir: string;
  timeoutMs?: number;
  /** Extra ssh options (tests). */
  sshExtra?: string[];
}

const ASKPASS = `#!/bin/sh
case "$1" in
  Username*|username*) printf '%s\\n' "$EGD_USER" ;;
  *) printf '%s\\n' "$EGD_SECRET" ;;
esac
`;

export class GitCommandError extends Error {
  constructor(
    msg: string,
    readonly code: number | null,
  ) {
    super(msg);
    this.name = "GitCommandError";
  }
}

const q = (s: string) => `"${s.replace(/\\/g, "/").replace(/(["$`])/g, "\\$1")}"`;

export function sshCommand(creds: Credentials | undefined, o: CliOptions, isWindows = process.platform === "win32"): string {
  const parts = ["ssh", "-o", "StrictHostKeyChecking=accept-new", "-o", `UserKnownHostsFile=${q(path.join(o.helperDir, "known_hosts"))}`];
  if (creds?.sshKeyPath) parts.push("-o", "IdentitiesOnly=yes", "-i", q(creds.sshKeyPath));
  if (o.proxy) {
    const u = new URL(o.proxy);
    const hp = `${u.hostname}:${u.port || (u.protocol.startsWith("socks") ? "1080" : "8080")}`;
    const socks = u.protocol.startsWith("socks");
    // Git for Windows ships connect.exe; Linux uses OpenBSD netcat.
    const pc = isWindows ? `connect ${socks ? "-S" : "-H"} ${hp} %h %p` : `nc -X ${socks ? "5" : "connect"} -x ${hp} %h %p`;
    parts.push("-o", q(`ProxyCommand=${pc}`));
  }
  parts.push(...(o.sshExtra ?? []));
  return parts.join(" ");
}

export class CliTransport implements Transport {
  private helperReady?: Promise<string>;

  constructor(
    private readonly repo: Repo,
    private readonly o: CliOptions,
  ) {}

  private helper(): Promise<string> {
    this.helperReady ??= (async () => {
      await fsp.mkdir(this.o.helperDir, { recursive: true });
      const p = path.join(this.o.helperDir, "askpass.sh");
      await fsp.writeFile(p, ASKPASS, { mode: 0o700 });
      await fsp.chmod(p, 0o700);
      return p;
    })();
    return this.helperReady;
  }

  private async run(args: string[], ep: Endpoint, creds: Credentials | undefined): Promise<string> {
    const askpass = await this.helper();
    const ssh = isSshUrl(ep.url);
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      GIT_ASKPASS: askpass,
      SSH_ASKPASS: askpass,
      SSH_ASKPASS_REQUIRE: "force",
      DISPLAY: process.env.DISPLAY || ":0",
      EGD_USER: creds?.username || "x-access-token",
      EGD_SECRET: (ssh ? creds?.sshPassphrase : creds?.password) ?? "",
      GIT_SSH_COMMAND: sshCommand(creds, this.o),
    };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    const cfg = ["-c", "credential.helper=", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "core.askPass="];
    if (this.o.proxy && !ssh) {
      const p = new URL(this.o.proxy);
      if (p.protocol === "socks5:") p.protocol = "socks5h:";
      cfg.push("-c", `http.proxy=${p.toString().replace(/\/$/, "")}`);
    }
    const full = [`--git-dir=${this.repo.gitdir}`, ...cfg, ...args];
    return new Promise((resolve, reject) => {
      const child = spawn(this.o.gitPath || "git", full, { env, windowsHide: true });
      let out = "";
      let err = "";
      const timer = setTimeout(() => child.kill(), this.o.timeoutMs ?? 120_000);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`Could not run git (${(e as NodeJS.ErrnoException).code}). Is Git installed? Set its path in settings.`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) return resolve(out);
        const msg = scrub(err.trim() || `git exited with ${code}`, creds);
        if (/Authentication failed|could not read (Username|Password)|Permission denied \(publickey|HTTP (Basic: Access denied|401|403)|returned error: 40[13]|incorrect passphrase|Invalid username or (password|token)|access to repository not granted/i.test(msg)) {
          const status = /\b403\b|not granted|permission|denied to/i.test(msg) && !/publickey|passphrase/i.test(msg) ? 403 : 401;
          const hostLine = msg.split("\n").find((l) => /^remote:/i.test(l))?.replace(/^remote:\s*/i, "") ?? msg.split("\n").slice(-1)[0];
          return reject(authProblem(status, hostLine, creds));
        }
        if (/protected branch|not allowed to force push|pre-receive hook declined/i.test(msg + out)) return reject(new ProtectedBranchError(msg.split("\n").find((l) => /protected|force push|declined/i.test(l)) ?? msg));
        if (/\[rejected\]|non-fast-forward|fetch first|\[remote rejected\].*(stale|lock)/i.test(msg + out)) return reject(new PushRejectedError());
        reject(new GitCommandError(friendlyNetworkError(msg.split("\n").filter(Boolean).slice(-3).join(" ")), code));
      });
    });
  }

  async fetch(ep: Endpoint): Promise<string | null> {
    const creds = await ep.getCredentials();
    checkUrlSafety(ep.url, !!creds?.password);
    const out = await this.run(["ls-remote", ep.url, `refs/heads/${BRANCH}`], ep, creds);
    const line = out.split("\n").find((l) => l.endsWith(`\trefs/heads/${BRANCH}`));
    if (!line) {
      await this.repo.setRemoteHead(ep.id, null);
      return null;
    }
    const oid = line.split("\t")[0];
    let have = true;
    try {
      await this.repo.readCommit(oid);
    } catch {
      have = false;
    }
    if (!have) {
      await this.run(["fetch", "--no-tags", "--no-write-fetch-head", "--quiet", ep.url, `+refs/heads/${BRANCH}:${Repo.remoteRef(ep.id)}`], ep, creds);
    }
    await this.repo.setRemoteHead(ep.id, oid);
    return oid;
  }

  async push(ep: Endpoint, oid: string, opts: { force?: boolean } = {}): Promise<void> {
    const creds = await ep.getCredentials();
    checkUrlSafety(ep.url, !!creds?.password);
    await this.run(["push", "--porcelain", "--quiet", ep.url, `${opts.force ? "+" : ""}${oid}:refs/heads/${BRANCH}`], ep, creds);
    await this.repo.setRemoteHead(ep.id, oid);
  }

  /** Check that git runs and report its version. */
  async version(): Promise<string> {
    return new Promise((resolve, reject) => {
      const c = spawn(this.o.gitPath || "git", ["--version"], { windowsHide: true });
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.on("error", () => reject(new Error("Git is not installed or not on PATH")));
      c.on("close", () => resolve(out.trim()));
    });
  }
}

/**
 * Create an ed25519 key protected by `passphrase` with ssh-keygen. The passphrase
 * goes through the askpass helper, not the command line. Returns the public key.
 */
export async function generateSshKey(helperDir: string, file: string, passphrase: string, comment = "encgidian"): Promise<string> {
  const askpass = path.join(helperDir, "askpass.sh");
  await fsp.mkdir(helperDir, { recursive: true });
  await fsp.writeFile(askpass, ASKPASS, { mode: 0o700 });
  await fsp.chmod(askpass, 0o700);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.rm(file, { force: true });
  await fsp.rm(file + ".pub", { force: true });
  await new Promise<void>((resolve, reject) => {
    const c = spawn("ssh-keygen", ["-q", "-t", "ed25519", "-C", comment, "-f", file], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // no controlling terminal, so ssh-keygen uses the askpass helper
      env: {
        ...(process.env as Record<string, string>),
        SSH_ASKPASS: askpass,
        SSH_ASKPASS_REQUIRE: "force",
        DISPLAY: process.env.DISPLAY || ":0",
        EGD_SECRET: passphrase,
      },
    });
    let err = "";
    c.stderr.on("data", (d) => (err += d));
    c.on("error", () => reject(new Error("ssh-keygen is not available (install OpenSSH / Git for Windows)")));
    c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ssh-keygen failed: ${err.trim()}`))));
  });
  return (await fsp.readFile(file + ".pub", "utf8")).trim();
}
