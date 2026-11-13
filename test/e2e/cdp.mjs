// Evaluate JavaScript in the Obsidian window over the Chrome DevTools Protocol.
// Usage: node test/e2e/cdp.mjs <port> '<expression>'   |   node test/e2e/cdp.mjs <port> --shot out.png
const [port, arg, out] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
// CDP_TITLE picks a window by title (e.g. the vault name) when several are open.
const want = process.env.CDP_TITLE;
const page = (want && targets.find((t) => t.type === "page" && t.title.includes(want) && !t.url.startsWith("about:"))) || (targets.find((t) => t.type === "page" && /obsidian\.md\/index\.html|localhost\/$|capacitor/.test(t.url)) ?? targets.find((t) => t.type === "page"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const call = (method, params) =>
  new Promise((resolve) => {
    const my = ++id;
    ws.addEventListener("message", function h(ev) {
      const m = JSON.parse(ev.data);
      if (m.id === my) {
        ws.removeEventListener("message", h);
        resolve(m);
      }
    });
    ws.send(JSON.stringify({ id: my, method, params }));
  });
if (arg === "--front") {
  await call("Page.bringToFront", {});
  console.log("brought to front");
} else if (arg === "--shot") {
  const r = await call("Page.captureScreenshot", { format: "png" });
  (await import("fs")).writeFileSync(out, Buffer.from(r.result.data, "base64"));
  console.log("saved", out);
} else {
  const r = await call("Runtime.evaluate", { expression: `(async () => { ${arg} })()`, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) console.log("EXCEPTION:", r.result.exceptionDetails.exception?.description ?? JSON.stringify(r.result.exceptionDetails));
  else console.log(typeof r.result.result.value === "string" ? r.result.result.value : JSON.stringify(r.result.result.value, null, 1));
}
ws.close();
