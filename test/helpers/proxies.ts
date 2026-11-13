// Minimal HTTP (CONNECT + absolute-form) and SOCKS5 proxies that count use.

import * as http from "http";
import * as net from "net";
import type { AddressInfo } from "net";

export class HttpProxy {
  server = http.createServer();
  port = 0;
  used = 0;
  async start() {
    this.server.on("connect", (req, client, head) => {
      this.used++;
      const [host, port] = (req.url ?? "").split(":");
      const up = net.connect(Number(port), host, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        up.write(head);
        up.pipe(client);
        client.pipe(up);
      });
      up.on("error", () => client.destroy());
      client.on("error", () => up.destroy());
    });
    this.server.on("request", (req, res) => {
      this.used++;
      const u = new URL(req.url ?? "");
      const p = http.request(
        { host: u.hostname, port: u.port, path: u.pathname + u.search, method: req.method, headers: req.headers },
        (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers);
          r.pipe(res);
        },
      );
      p.on("error", () => res.destroy());
      req.pipe(p);
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as AddressInfo).port;
  }
  url() {
    return `http://127.0.0.1:${this.port}`;
  }
  async stop() {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

export class Socks5Proxy {
  server = net.createServer((c) => this.handle(c));
  port = 0;
  used = 0;
  private sockets = new Set<net.Socket>();
  private handle(c: net.Socket) {
    this.sockets.add(c);
    c.on("close", () => this.sockets.delete(c));
    c.on("error", () => {});
    c.once("data", (greet: Buffer) => {
      if (greet[0] !== 5) return c.destroy();
      c.write(Buffer.from([5, 0]));
      c.once("data", (req: Buffer) => {
        if (req[0] !== 5 || req[1] !== 1) return c.destroy();
        let host: string;
        let off: number;
        if (req[3] === 1) {
          host = [...req.subarray(4, 8)].join(".");
          off = 8;
        } else if (req[3] === 3) {
          const n = req[4];
          host = req.subarray(5, 5 + n).toString();
          off = 5 + n;
        } else return c.destroy();
        const port = req.readUInt16BE(off);
        this.used++;
        const up = net.connect(port, host, () => {
          c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          up.pipe(c);
          c.pipe(up);
        });
        up.on("error", () => c.destroy());
        this.sockets.add(up);
        up.on("close", () => this.sockets.delete(up));
      });
    });
  }
  async start() {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as AddressInfo).port;
  }
  url() {
    return `socks5://127.0.0.1:${this.port}`;
  }
  async stop() {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}
