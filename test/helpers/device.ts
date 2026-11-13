// A simulated device: a vault folder, its own bare repo and state, and a SyncEngine.

import * as fs from "fs";
import * as path from "path";
import { Repo } from "../../src/core/repo";
import { SyncEngine, SyncOptions } from "../../src/core/sync";
import { createKeyFile, KeyFile, unlockWithPassword, VaultKeys } from "../../src/core/keys";
import { Credentials, Endpoint, IsoTransport, Transport } from "../../src/core/transport";
import { makeNodeHttp } from "../../src/platform/http-node";
import { FolderVault, JsonFileState } from "../../src/platform/vault-node";
import { NtfsVault } from "./ntfs";
export interface Server {
  url(): string;
}

export const FAST = { memoryKiB: 1024, iterations: 1, parallelism: 1 };

export interface DeviceOpts {
  password?: string;
  servers: Server[];
  options?: Partial<SyncOptions>;
  creds?: Credentials | ((url: string) => Credentials | undefined);
  proxy?: string;
  transport?: (repo: Repo, ep: Endpoint) => Transport;
  /** File system for the device's Git repo (default: Node's fs). */
  repoFs?: unknown;
  /** Use a simulated Windows (NTFS, case-insensitive) vault folder. */
  ntfs?: boolean;
  /** Record the size of every HTTP request and response body. */
  traffic?: { maxDown: number; maxUp: number; requests: number };
}

export class Device {
  readonly vaultDir: string;
  readonly repo: Repo;
  readonly vault: FolderVault;
  readonly engine: SyncEngine;
  password: string;
  servers: Server[];
  private keys?: VaultKeys;
  options: SyncOptions;
  unlockCount = 0;

  constructor(
    readonly name: string,
    readonly root: string,
    o: DeviceOpts,
  ) {
    this.vaultDir = path.join(root, "vault");
    fs.mkdirSync(this.vaultDir, { recursive: true });
    this.password = o.password ?? "pw";
    this.servers = o.servers;
    this.repo = new Repo(o.repoFs ?? fs, path.join(root, "repo"));
    this.vault = o.ntfs ? new NtfsVault(this.vaultDir) : new FolderVault(this.vaultDir);
    this.options = {
      device: name,
      configDir: ".obsidian",
      pluginDir: ".obsidian/plugins/encgidian",
      syncConfigDir: false,
      ignoredFolders: [],
      maxFileSize: 0,
      ...o.options,
    };
    const base = makeNodeHttp({ proxy: o.proxy, timeoutMs: 20000 });
    const tr = o.traffic;
    const http = tr
      ? {
          async request(r: any) {
            let up = 0;
            const chunks: Uint8Array[] = [];
            if (r.body) for await (const c of r.body) (chunks.push(c), (up += c.length));
            async function* again() {
              for (const c of chunks) yield c;
            }
            const res = await base.request({ ...r, body: r.body ? again() : undefined });
            const parts: Uint8Array[] = [];
            let down = 0;
            for await (const c of res.body!) (parts.push(c), (down += c.length));
            tr.requests++;
            tr.maxUp = Math.max(tr.maxUp, up);
            tr.maxDown = Math.max(tr.maxDown, down);
            async function* out() {
              for (const c of parts) yield c;
            }
            return { ...res, body: out() };
          },
        }
      : base;
    const iso = new IsoTransport(this.repo, http);
    this.engine = new SyncEngine({
      repo: this.repo,
      vault: this.vault,
      state: new JsonFileState(path.join(root, "state.json")),
      keys: {
        unlock: async (kf: KeyFile) => {
          if (this.keys?.vaultId === kf.vaultId) return this.keys;
          this.unlockCount++;
          this.keys = await unlockWithPassword(kf, this.password);
          return this.keys;
        },
        create: async () => {
          const r = await createKeyFile(this.password, FAST);
          this.keys = r.keys;
          return r;
        },
      },
      transportFor: (ep) => (o.transport ? o.transport(this.repo, ep) : iso),
      endpoints: () =>
        this.servers.map((s, i) => ({
          id: `r${i}`,
          name: `server${i}`,
          url: s.url(),
          getCredentials: async () => (typeof o.creds === "function" ? o.creds(s.url()) : o.creds),
        })),
      options: () => this.options,
    });
  }

  forgetKeys() {
    this.keys = undefined;
  }

  file(p: string): string | null {
    try {
      return fs.readFileSync(path.join(this.vaultDir, p), "utf8");
    } catch {
      return null;
    }
  }

  put(p: string, text: string, mtime = Date.now()) {
    const a = path.join(this.vaultDir, p);
    fs.mkdirSync(path.dirname(a), { recursive: true });
    fs.writeFileSync(a, text);
    // ensure the scanner notices the change even within the same millisecond
    fs.utimesSync(a, new Date(), new Date(mtime));
  }

  del(p: string) {
    fs.rmSync(path.join(this.vaultDir, p));
  }

  mv(from: string, to: string) {
    const a = path.join(this.vaultDir, to);
    fs.mkdirSync(path.dirname(a), { recursive: true });
    fs.renameSync(path.join(this.vaultDir, from), a);
  }

  files(): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (dir: string, rel: string) => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        const r = rel ? `${rel}/${d.name}` : d.name;
        if (d.isDirectory()) walk(path.join(dir, d.name), r);
        else out[r] = fs.readFileSync(path.join(dir, d.name), "utf8");
      }
    };
    walk(this.vaultDir, "");
    return out;
  }

  sync() {
    return this.engine.sync();
  }
}
