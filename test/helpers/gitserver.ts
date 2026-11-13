// A real Git smart-HTTP server for tests: Node HTTP in front of `git http-backend`.
// Supports Basic auth and being switched "down".

import { spawn, execFileSync } from "child_process";
import * as http from "http";
import * as path from "path";
import { mkdirSync } from "fs";
import type { AddressInfo } from "net";

export class GitServer {
  private server?: http.Server;
  port = 0;
  down = false;
  /** When set, requests must carry these Basic credentials. */
  auth?: { username: string; password: string };
  requests = 0;

  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
  }

  createRepo(name = "vault"): string {
    const dir = path.join(this.root, `${name}.git`);
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", dir]);
    execFileSync("git", ["-C", dir, "config", "http.receivepack", "true"]);
    return dir;
  }

  url(name = "vault"): string {
    return `http://127.0.0.1:${this.port}/${name}.git`;
  }

  /** Commit id of main on the server, or null. */
  head(name = "vault"): string | null {
    try {
      return execFileSync("git", ["-C", path.join(this.root, `${name}.git`), "rev-parse", "--verify", "-q", "refs/heads/main"])
        .toString()
        .trim();
    } catch {
      return null;
    }
  }

  async start(port = 0): Promise<void> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(port, "127.0.0.1", r));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server?.closeAllConnections?.();
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    this.requests++;
    if (this.down) {
      req.socket.destroy();
      return;
    }
    let user = "";
    if (this.auth) {
      const h = req.headers.authorization ?? "";
      const [u, p] = h.startsWith("Basic ") ? Buffer.from(h.slice(6), "base64").toString().split(/:(.*)/s) : ["", ""];
      if (u !== this.auth.username || p !== this.auth.password) {
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="test"' });
        res.end("unauthorized");
        return;
      }
      user = u;
    }
    const u = new URL(req.url ?? "/", "http://x");
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      GIT_PROJECT_ROOT: this.root,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: decodeURIComponent(u.pathname),
      REQUEST_METHOD: req.method ?? "GET",
      QUERY_STRING: u.search.slice(1),
      CONTENT_TYPE: req.headers["content-type"] ?? "",
      REMOTE_USER: user || "test",
      REMOTE_ADDR: "127.0.0.1",
    };
    if (req.headers["content-encoding"]) env.HTTP_CONTENT_ENCODING = String(req.headers["content-encoding"]);
    if (req.headers["git-protocol"]) env.GIT_PROTOCOL = String(req.headers["git-protocol"]);
    const cgi = spawn("git", ["http-backend"], { env });
    req.pipe(cgi.stdin);
    const chunks: Buffer[] = [];
    cgi.stdout.on("data", (c) => chunks.push(c));
    cgi.on("close", () => {
      const out = Buffer.concat(chunks);
      const sep = out.indexOf("\r\n\r\n");
      const head = out.subarray(0, sep).toString();
      const body = out.subarray(sep + 4);
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of head.split("\r\n")) {
        const i = line.indexOf(":");
        const k = line.slice(0, i).trim();
        const v = line.slice(i + 1).trim();
        if (k.toLowerCase() === "status") status = parseInt(v, 10);
        else if (k) headers[k] = v;
      }
      res.writeHead(status, headers);
      res.end(body);
    });
  }
}
