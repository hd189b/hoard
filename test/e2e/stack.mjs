// Pause the Obsidian page and print where it is running (for hangs).
const port = process.argv[2];
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.url.startsWith("app://obsidian.md/index.html"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === "Debugger.paused") {
    for (const f of m.params.callFrames.slice(0, 12)) console.log(f.functionName || "(anon)", f.url.slice(-40), f.location.lineNumber, f.location.columnNumber);
    ws.send(JSON.stringify({ id: 99, method: "Debugger.resume" }));
    setTimeout(() => process.exit(0), 200);
  }
};
ws.send(JSON.stringify({ id: 1, method: "Debugger.enable" }));
ws.send(JSON.stringify({ id: 2, method: "Debugger.pause" }));
setTimeout(() => { console.log("no pause event"); process.exit(1); }, 8000);
