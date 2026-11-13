// Secret storage on Linux. Checked in this order:
//   1. KeePassXC (Secret Service integration on), via `secret-tool`
//   2. KWallet, via `kwallet-query`
//   3. GNOME Keyring or another Secret Service provider, via `secret-tool`
//   4. Plain text file readable only by this user (with a warning)

import { spawn } from "child_process";
import { promises as fsp, readFileSync } from "fs";
import * as os from "os";
import * as path from "path";
import type { SecretStore } from "../core/secrets";

export type LinuxBackend = "keepassxc" | "kwallet" | "gnome" | "plaintext";

export const LINUX_BACKEND_ORDER: LinuxBackend[] = ["keepassxc", "kwallet", "gnome", "plaintext"];

export const LINUX_BACKEND_LABEL: Record<LinuxBackend, string> = {
  keepassxc: "KeePassXC",
  kwallet: "KWallet",
  gnome: "GNOME Keyring / Secret Service",
  plaintext: "Plain text file (not encrypted)",
};

interface RunResult {
  code: number | null;
  out: string;
  err: string;
}

function run(cmd: string, args: string[], input?: string, timeoutMs = 15000): Promise<RunResult> {
  return new Promise((resolve) => {
    let c;
    try {
      c = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      return resolve({ code: -1, out: "", err: "spawn failed" });
    }
    let out = "";
    let err = "";
    const t = setTimeout(() => c.kill(), timeoutMs);
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    c.on("error", () => {
      clearTimeout(t);
      resolve({ code: -1, out, err: `${cmd} not found` });
    });
    c.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, out, err });
    });
    if (input !== undefined) c.stdin.end(input);
    else c.stdin.end();
  });
}

async function has(cmd: string): Promise<boolean> {
  return (await run("sh", ["-c", `command -v ${cmd}`])).code === 0;
}

const dbus = (method: string, ...args: string[]) =>
  run("dbus-send", ["--session", "--print-reply", "--dest=org.freedesktop.DBus", "/org/freedesktop/DBus", `org.freedesktop.DBus.${method}`, ...args], undefined, 5000);

/** Name of the program that currently provides the Secret Service, if any. */
const procName = (pid: string) => readFileSync(`/proc/${pid}/comm`, "utf8").trim();

async function secretServiceOwner(readComm: (pid: string) => string): Promise<string | null> {
  const r = await dbus("GetConnectionUnixProcessID", "string:org.freedesktop.secrets");
  const m = r.out.match(/uint32\s+(\d+)/);
  if (r.code !== 0 || !m) return null;
  try {
    return readComm(m[1]);
  } catch {
    return "unknown";
  }
}

async function busNames(): Promise<Set<string>> {
  const out = new Set<string>();
  for (const m of ["ListNames", "ListActivatableNames"]) {
    const r = await dbus(m);
    for (const x of r.out.matchAll(/string "([^"]+)"/g)) out.add(x[1]);
  }
  return out;
}

const KWALLETD = ["kwalletd6", "kwalletd5"];

/** Names of existing KWallet wallets, without opening (or prompting for) any. Null if KWallet isn't running/activatable. */
export async function kwalletWallets(): Promise<{ service: string; wallets: string[] } | null> {
  for (const d of KWALLETD) {
    const r = await run("dbus-send", ["--session", "--print-reply", `--dest=org.kde.${d}`, `/modules/${d}`, "org.kde.KWallet.wallets"], undefined, 10000);
    if (r.code === 0) return { service: d, wallets: [...r.out.matchAll(/string "([^"]+)"/g)].map((m) => m[1]) };
  }
  return null;
}

/**
 * Ask KWallet to open the default wallet. If it doesn't exist, KWallet shows its own
 * window to create it (the user picks the wallet password there). True when it's ready.
 */
export async function createKWallet(): Promise<boolean> {
  const kw = await kwalletWallets();
  if (!kw) throw new Error("KWallet isn't available in this session");
  const name = kwalletName();
  const r = await run(
    "dbus-send",
    ["--session", "--print-reply", "--reply-timeout=300000", `--dest=org.kde.${kw.service}`, `/modules/${kw.service}`, "org.kde.KWallet.open", `string:${name}`, "int64:0", "string:Hoard"],
    undefined,
    310000,
  );
  const m = r.out.match(/int32\s+(-?\d+)/);
  return r.code === 0 && !!m && Number(m[1]) >= 0;
}

export interface Detection {
  available: LinuxBackend[];
  /** Why each missing backend is missing. */
  notes: Partial<Record<LinuxBackend, string>>;
  /** KWallet runs but has no wallet yet (one can be created). */
  kwalletNeedsWallet?: boolean;
}

export async function detectLinuxBackends(readComm: (pid: string) => string = procName): Promise<Detection> {
  const notes: Detection["notes"] = {};
  const available: LinuxBackend[] = [];
  let noWallet = false;
  const [secretTool, kwq, owner, names] = await Promise.all([has("secret-tool"), has("kwallet-query"), secretServiceOwner(readComm), busNames()]);

  if (owner && /keepassxc/i.test(owner)) {
    if (secretTool) available.push("keepassxc");
    else notes.keepassxc = "Install libsecret (secret-tool) to use KeePassXC";
  } else {
    notes.keepassxc = "KeePassXC isn't running with Secret Service integration turned on";
  }

  if (kwq && (names.has("org.kde.kwalletd6") || names.has("org.kde.kwalletd5") || names.has("org.kde.kwalletd"))) {
    const kw = await kwalletWallets();
    if (kw && kw.wallets.includes(kwalletName())) available.push("kwallet");
    else {
      notes.kwallet = `KWallet has no wallet named “${kwalletName()}” yet. Use “Create KWallet wallet” to make one.`;
      noWallet = true;
    }
  } else notes.kwallet = kwq ? "KWallet isn't available in this session" : "kwallet-query isn't installed";

  // KWallet 6 also serves the Secret Service interface (ksecretd); that is KWallet, not a separate keyring.
  const ownerIsKWallet = !!owner && /ksecretd|kwalletd/i.test(owner);
  const otherOwner = owner && !/keepassxc/i.test(owner) && !ownerIsKWallet;
  if (secretTool && (otherOwner || (!owner && names.has("org.freedesktop.secrets")))) available.push("gnome");
  else if (ownerIsKWallet) notes.gnome = "The Secret Service here is provided by KWallet; use the KWallet option";
  else notes.gnome = secretTool ? "No Secret Service keyring found" : "secret-tool (libsecret) isn't installed";

  available.push("plaintext");
  return { available, notes, kwalletNeedsWallet: noWallet };
}

export function pickDefault(d: Detection): LinuxBackend {
  return LINUX_BACKEND_ORDER.find((b) => d.available.includes(b)) ?? "plaintext";
}

class SecretToolStore implements SecretStore {
  constructor(
    readonly kind: LinuxBackend,
    private readonly ns: string,
  ) {}
  get label() {
    return LINUX_BACKEND_LABEL[this.kind];
  }
  private attrs(key: string) {
    return ["service", "hoard", "account", `${this.ns}:${key}`];
  }
  async get(key: string) {
    const r = await run("secret-tool", ["lookup", ...this.attrs(key)]);
    if (r.code !== 0) {
      if (r.err.trim()) throw new Error(`${this.label}: ${r.err.trim()}`);
      return null; // not found
    }
    return r.out;
  }
  async set(key: string, value: string) {
    const r = await run("secret-tool", ["store", `--label=Hoard ${key}`, ...this.attrs(key)], value);
    if (r.code !== 0) throw new Error(`${this.label}: ${r.err.trim() || "could not store secret (is it unlocked?)"}`);
  }
  async delete(key: string) {
    await run("secret-tool", ["clear", ...this.attrs(key)]);
  }
}

function kwalletName(): string {
  for (const f of ["kwalletrc"]) {
    try {
      const txt = readFileSync(path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), f), "utf8");
      const m = txt.match(/^Default Wallet=(.+)$/m);
      if (m) return m[1].trim();
    } catch {
      /* default below */
    }
  }
  return "kdewallet";
}

class KWalletStore implements SecretStore {
  readonly kind = "kwallet" as const;
  readonly label = LINUX_BACKEND_LABEL.kwallet;
  private readonly wallet = kwalletName();
  constructor(private readonly ns: string) {}
  private entry(key: string) {
    return `${this.ns}:${key}`;
  }
  async get(key: string) {
    const r = await run("kwallet-query", ["-f", "hoard", "-r", this.entry(key), this.wallet], undefined, 60000);
    if (r.code !== 0) {
      if (/Wallet .* not found/i.test(r.err + r.out)) throw new Error(`KWallet has no wallet “${this.wallet}” yet; create it from the plugin settings`);
      // Real kwallet-query says "Failed to read entry … value" for a missing entry.
      if (/not found|does not exist|no such|Failed to read entry/i.test(r.err + r.out)) return null;
      throw new Error(`KWallet: ${(r.err || r.out).trim() || "could not read (is the wallet open?)"}`);
    }
    const v = r.out.replace(/\n$/, "");
    return v === "" ? null : v;
  }
  async set(key: string, value: string) {
    const r = await run("kwallet-query", ["-f", "hoard", "-w", this.entry(key), this.wallet], value, 60000);
    if (r.code !== 0) throw new Error(`KWallet: ${(r.err || r.out).trim() || "could not store secret"}`);
  }
  async delete(key: string) {
    // kwallet-query can't delete; overwrite with an empty value.
    await run("kwallet-query", ["-f", "hoard", "-w", this.entry(key), this.wallet], "", 60000);
  }
}

export class PlaintextStore implements SecretStore {
  readonly kind = "plaintext" as const;
  readonly label = LINUX_BACKEND_LABEL.plaintext;
  readonly file: string;
  constructor(ns: string, dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "hoard")) {
    this.file = path.join(dir, `secrets-${ns.replace(/[^a-z0-9-]/gi, "_")}.json`);
  }
  private async load(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await fsp.readFile(this.file, "utf8"));
    } catch {
      return {};
    }
  }
  private async save(d: Record<string, string>) {
    await fsp.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await fsp.chmod(path.dirname(this.file), 0o700);
    const tmp = this.file + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(d, null, 1), { mode: 0o600 });
    await fsp.chmod(tmp, 0o600);
    await fsp.rename(tmp, this.file);
  }
  async get(key: string) {
    return (await this.load())[key] ?? null;
  }
  async set(key: string, value: string) {
    const d = await this.load();
    d[key] = value;
    await this.save(d);
  }
  async delete(key: string) {
    const d = await this.load();
    delete d[key];
    await this.save(d);
  }
}

export function linuxStore(kind: LinuxBackend, ns: string, plaintextDir?: string): SecretStore {
  switch (kind) {
    case "keepassxc":
    case "gnome":
      return new SecretToolStore(kind, ns);
    case "kwallet":
      return new KWalletStore(ns);
    case "plaintext":
      return new PlaintextStore(ns, plaintextDir);
  }
}
