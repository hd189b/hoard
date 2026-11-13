// isomorphic-git HTTP client for desktop (Node / Electron), with optional
// HTTP or SOCKS5 proxy. Not loaded on Android.

import * as http from "http";
import * as https from "https";
import type { GitHttpRequest, GitHttpResponse, HttpClient } from "isomorphic-git";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

export interface NodeHttpOptions {
  /** e.g. "http://127.0.0.1:8080" or "socks5://127.0.0.1:1080" */
  proxy?: string;
  timeoutMs?: number;
}

export function proxyAgent(proxy: string): http.Agent {
  const u = new URL(proxy);
  if (/^socks(4a?|5h?)?:$/.test(u.protocol)) {
    // socks5h: let the proxy resolve host names (no DNS leaks).
    if (u.protocol === "socks5:") u.protocol = "socks5h:";
    return new SocksProxyAgent(u.toString());
  }
  if (u.protocol === "http:" || u.protocol === "https:") return new HttpsProxyAgent(u.toString());
  throw new Error(`Unsupported proxy type ${u.protocol} (use http:// or socks5://)`);
}

async function collect(body?: AsyncIterableIterator<Uint8Array>): Promise<Buffer | undefined> {
  if (!body) return undefined;
  const parts: Buffer[] = [];
  for await (const c of body) parts.push(Buffer.from(c));
  return Buffer.concat(parts);
}

async function* once(b: Buffer): AsyncIterableIterator<Uint8Array> {
  yield new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}

export function makeNodeHttp(opts: NodeHttpOptions = {}): HttpClient {
  const agent = opts.proxy ? proxyAgent(opts.proxy) : undefined;
  const timeout = opts.timeoutMs ?? 60_000;

  const requestOnce = (url: string, method: string, headers: Record<string, string>, body?: Buffer) =>
    new Promise<{ res: http.IncomingMessage; data: Buffer }>((resolve, reject) => {
      const u = new URL(url);
      const mod = u.protocol === "https:" ? https : http;
      const req = mod.request(
        u,
        { method, headers: { ...headers, ...(body ? { "content-length": String(body.length) } : {}) }, agent, timeout },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve({ res, data: Buffer.concat(chunks) }));
          res.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new Error(`Timed out after ${timeout / 1000}s`)));
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });

  return {
    async request(r: GitHttpRequest): Promise<GitHttpResponse> {
      const method = r.method ?? "GET";
      const body = await collect(r.body);
      let url = r.url;
      for (let i = 0; ; i++) {
        const { res, data } = await requestOnce(url, method, r.headers ?? {}, body);
        const loc = res.headers.location;
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && loc && i < 5 && method === "GET") {
          const next = new URL(loc, url);
          if (new URL(url).protocol === "https:" && next.protocol !== "https:") throw new Error("Refusing redirect from https to http");
          url = next.toString();
          continue;
        }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
        return {
          url,
          method,
          statusCode: res.statusCode ?? 0,
          statusMessage: res.statusMessage ?? "",
          headers,
          body: once(data),
        };
      }
    },
  };
}
