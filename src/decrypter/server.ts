// Local web interface for the decrypter. Listens on 127.0.0.1 only, and every
// API call must carry a random token that is only in the URL opened in the browser.

import * as http from "http";
import * as path from "path";
import * as os from "os";
import type { AddressInfo } from "net";
import { WrongPasswordError } from "../core/keys";
import { VaultReader } from "./reader";
import { UI_HTML } from "./ui";

const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",
};

export function contentType(p: string): string {
  const ext = p.slice(p.lastIndexOf(".") + 1).toLowerCase();
  return TYPES[ext] ?? "application/octet-stream";
}

export async function startServer(reader: VaultReader, port = 0): Promise<{ url: string; close: () => Promise<void> }> {
  const token = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");
  let actualPort = 0;

  const json = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  const body = (req: http.IncomingMessage) =>
    new Promise<Record<string, string>>((resolve, reject) => {
      let s = "";
      req.on("data", (d) => {
        s += d;
        if (s.length > 1e5) req.destroy();
      });
      req.on("end", () => {
        try {
          resolve(s ? JSON.parse(s) : {});
        } catch (e) {
          reject(e);
        }
      });
    });

  const server = http.createServer(async (req, res) => {
    try {
      // Refuse requests addressed to any other host name (DNS rebinding).
      const host = req.headers.host ?? "";
      if (host !== `127.0.0.1:${actualPort}` && host !== `localhost:${actualPort}`) {
        res.writeHead(403).end();
        return;
      }
      const u = new URL(req.url ?? "/", `http://${host}`);
      if (u.pathname === "/" && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob:; media-src blob:; connect-src 'self'; frame-src blob:",
          "cache-control": "no-store",
        });
        res.end(UI_HTML);
        return;
      }
      if (!u.pathname.startsWith("/api/")) return json(res, 404, { error: "not found" });
      if (req.headers["x-token"] !== token && u.searchParams.get("t") !== token) return json(res, 401, { error: "bad token" });

      const q = (k: string) => u.searchParams.get(k) ?? "";
      switch (u.pathname) {
        case "/api/info":
          return json(res, 200, {
            unlocked: reader.unlocked,
            repo: reader.gitdir,
            vaultId: reader.keyFile.vaultId,
            defaultExport: path.join(os.homedir(), `encgidian-export-${new Date().toISOString().slice(0, 10)}`),
          });
        case "/api/unlock": {
          const b = await body(req);
          try {
            if (b.recoveryKey) await reader.unlockRecoveryKey(b.recoveryKey);
            else await reader.unlockPassword(b.password ?? "");
            return json(res, 200, { ok: true });
          } catch (e) {
            if (e instanceof WrongPasswordError) return json(res, 403, { error: e.message });
            throw e;
          }
        }
      }
      if (!reader.unlocked) return json(res, 423, { error: "locked" });
      switch (u.pathname) {
        case "/api/commits":
          return json(res, 200, (await reader.commits()).map((c) => ({ oid: c.oid, time: c.time })));
        case "/api/snapshot": {
          const m = await reader.snapshot(await reader.resolveCommit(q("c")));
          return json(
            res,
            200,
            [...m.values()].sort((a, b) => a.p.localeCompare(b.p)).map((e) => ({ path: e.p, size: e.s, mtime: e.t, device: e.d })),
          );
        }
        case "/api/versions":
          return json(
            res,
            200,
            (await reader.versions(q("path"))).map((v) => ({ commit: v.commit, time: v.time, size: v.entry.s, device: v.entry.d, obj: v.entry.o })),
          );
        case "/api/deleted":
          return json(
            res,
            200,
            (await reader.deleted()).map((d) => ({ path: d.path, time: d.last.time, commit: d.last.commit, size: d.last.entry.s })),
          );
        case "/api/raw": {
          const p = q("path");
          let data: Uint8Array;
          if (q("obj")) {
            const v = (await reader.versions(p)).find((x) => x.entry.o === q("obj"));
            if (!v) return json(res, 404, { error: "no such version" });
            data = await reader.readObject(v.entry);
          } else {
            data = (await reader.read(await reader.resolveCommit(q("c")), p)).data;
          }
          const name = p.slice(p.lastIndexOf("/") + 1);
          res.writeHead(200, {
            "content-type": q("download") ? "application/octet-stream" : contentType(p),
            "content-length": String(data.length),
            "content-security-policy": "sandbox",
            "x-content-type-options": "nosniff",
            "cache-control": "no-store",
            ...(q("download") ? { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}` } : {}),
          });
          res.end(data);
          return;
        }
        case "/api/export": {
          const b = await body(req);
          const dir = path.resolve(b.dir || "");
          const n = await reader.exportTo(await reader.resolveCommit(b.c), dir);
          return json(res, 200, { count: n, dir });
        }
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 500, { error: (e as Error).message });
    }
  });

  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  actualPort = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${actualPort}/#t=${token}`,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
