// encgidian-decrypt: read an encgidian vault from a Git repository without Obsidian.

import { spawn } from "child_process";
import * as fs from "fs";
import { WrongPasswordError } from "../core/keys";
import { ReaderError, VaultReader } from "./reader";
import { startServer } from "./server";

const HELP = `encgidian-decrypt — read an encrypted Obsidian vault without Obsidian

Usage:
  encgidian-decrypt [REPO]                     open the browser interface (default)
  encgidian-decrypt list REPO [--at SYNC]      list files in a sync (default: latest)
  encgidian-decrypt syncs REPO                 list every sync with its date
  encgidian-decrypt history REPO PATH          list every version of a file
  encgidian-decrypt cat REPO PATH [--at SYNC] [--version N]
                                               print a file (N=1 is newest)
  encgidian-decrypt deleted REPO               list deleted files
  encgidian-decrypt export REPO DIR [--at SYNC]
                                               write every file of a sync to DIR

REPO is a clone of any of your Git hosts (git clone URL), normal or bare.
SYNC is a sync id (or its first characters) from "syncs".

The password is asked for interactively. For scripts, set ENCGIDIAN_PASSWORD
or ENCGIDIAN_RECOVERY_KEY. Add --recovery-key to type a recovery key instead.
Options for the browser interface: --port N, --no-open.
`;

function askHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    if (!stdin.isTTY) {
      let s = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (d) => (s += d));
      stdin.on("end", () => resolve(s.replace(/\r?\n$/, "")));
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let s = "";
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stderr.write("\n");
          return resolve(s);
        }
        if (c === "\u0003") {
          stdin.setRawMode(false);
          process.stderr.write("\n");
          return reject(new Error("Cancelled"));
        }
        if (c === "\u007f" || c === "\b") s = s.slice(0, -1);
        else s += c;
      }
    };
    stdin.on("data", onData);
  });
}

async function unlock(r: VaultReader, useRecovery: boolean) {
  if (process.env.ENCGIDIAN_RECOVERY_KEY) return r.unlockRecoveryKey(process.env.ENCGIDIAN_RECOVERY_KEY);
  if (process.env.ENCGIDIAN_PASSWORD) return r.unlockPassword(process.env.ENCGIDIAN_PASSWORD);
  for (let i = 0; i < 3; i++) {
    try {
      if (useRecovery) return await r.unlockRecoveryKey(await askHidden("Recovery key: "));
      return await r.unlockPassword(await askHidden("Vault password: "));
    } catch (e) {
      if (!(e instanceof WrongPasswordError) || i === 2) throw e;
      process.stderr.write(`${e.message}. Try again.\n`);
    }
  }
}

const date = (s: number) => new Date(s * 1000).toLocaleString();

function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url.replace(/&/g, "^&")]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd as string, args as string[], { stdio: "ignore", detached: true, windowsHide: true }).on("error", () => {}).unref();
  } catch {
    /* the URL is printed anyway */
  }
}

export async function main(argv: string[]): Promise<number> {
  const flags = new Map<string, string | true>();
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") flags.set("help", true);
    else if (a.startsWith("--")) {
      const k = a.slice(2);
      if (["at", "version", "port"].includes(k)) flags.set(k, argv[++i] ?? "");
      else flags.set(k, true);
    } else pos.push(a);
  }
  if (flags.has("help")) {
    process.stdout.write(HELP);
    return 0;
  }
  const commands = ["list", "syncs", "history", "cat", "deleted", "export", "serve"];
  const cmd = commands.includes(pos[0]) ? pos.shift()! : "serve";
  const repoDir = pos.shift() ?? ".";
  const at = flags.get("at") as string | undefined;

  const r = await VaultReader.open(repoDir);

  if (cmd === "serve") {
    const s = await startServer(r, Number(flags.get("port") ?? 0));
    process.stdout.write(`Decrypter running. Open this link in your browser (only this computer can reach it):\n\n  ${s.url}\n\nPress Ctrl+C to stop.\n`);
    if (!flags.has("no-open")) openBrowser(s.url);
    await new Promise<void>((res) => {
      process.on("SIGINT", res);
      process.on("SIGTERM", res);
    });
    await s.close();
    return 0;
  }

  await unlock(r, flags.has("recovery-key"));
  const out = (s: string) => process.stdout.write(s + "\n");

  switch (cmd) {
    case "syncs":
      for (const c of await r.commits()) out(`${c.oid.slice(0, 10)}  ${date(c.time)}`);
      return 0;
    case "list": {
      const m = await r.snapshot(await r.resolveCommit(at));
      for (const e of [...m.values()].sort((a, b) => a.p.localeCompare(b.p))) out(`${String(e.s).padStart(10)}  ${new Date(e.t).toLocaleString()}  ${e.p}`);
      return 0;
    }
    case "history": {
      const p = pos.shift();
      if (!p) throw new ReaderError("history needs a file path");
      const vs = await r.versions(p);
      if (!vs.length) throw new ReaderError(`No versions of "${p}"`);
      vs.forEach((v, i) => out(`${String(i + 1).padStart(3)}  ${date(v.time)}  ${String(v.entry.s).padStart(9)} B  ${v.entry.d}  (sync ${v.commit.slice(0, 10)})`));
      return 0;
    }
    case "cat": {
      const p = pos.shift();
      if (!p) throw new ReaderError("cat needs a file path");
      let data: Uint8Array;
      if (flags.has("version")) {
        const n = Number(flags.get("version"));
        const vs = await r.versions(p);
        if (!(n >= 1 && n <= vs.length)) throw new ReaderError(`Version must be 1..${vs.length}`);
        data = await r.readObject(vs[n - 1].entry);
      } else data = (await r.read(await r.resolveCommit(at), p)).data;
      process.stdout.write(data);
      return 0;
    }
    case "deleted": {
      for (const d of await r.deleted()) out(`${date(d.last.time)}  ${d.path}`);
      return 0;
    }
    case "export": {
      const dir = pos.shift();
      if (!dir) throw new ReaderError("export needs a target folder");
      if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new ReaderError(`${dir} is not empty; choose an empty or new folder`);
      const n = await r.exportTo(await r.resolveCommit(at), dir);
      out(`Exported ${n} files to ${dir}`);
      return 0;
    }
  }
  return 1;
}
