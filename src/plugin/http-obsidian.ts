// isomorphic-git HTTP client using Obsidian's requestUrl (no CORS limits).
// Used on Android; the phone's own proxy/VPN settings apply.

import { requestUrl } from "obsidian";
import type { GitHttpRequest, GitHttpResponse, HttpClient } from "isomorphic-git";

async function collect(body?: AsyncIterableIterator<Uint8Array>): Promise<ArrayBuffer | undefined> {
  if (!body) return undefined;
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const c of body) {
    parts.push(c);
    n += c.length;
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out.buffer;
}

async function* once(b: ArrayBuffer): AsyncIterableIterator<Uint8Array> {
  yield new Uint8Array(b);
}

export const obsidianHttp: HttpClient = {
  async request(r: GitHttpRequest): Promise<GitHttpResponse> {
    const method = r.method ?? "GET";
    const res = await requestUrl({
      url: r.url,
      method,
      headers: r.headers,
      body: await collect(r.body),
      throw: false,
    });
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers ?? {})) headers[k.toLowerCase()] = String(v);
    return {
      url: r.url,
      method,
      statusCode: res.status,
      statusMessage: String(res.status),
      headers,
      body: once(res.arrayBuffer),
    };
  },
};
