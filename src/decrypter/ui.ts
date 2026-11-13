// The decrypter's single-page interface (served from 127.0.0.1 only).

export const UI_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Encgidian Decrypter</title>
<style>
:root {
  --bg: #f7f7f5; --panel: #ffffff; --ink: #1d1d1b; --muted: #6b6b66; --line: #e4e3df;
  --accent: #5b4bd6; --accent-ink: #ffffff; --sel: #ecebfb; --warn: #b4331f; --mono: ui-monospace, "Cascadia Mono", "JetBrains Mono", Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #161615; --panel: #1f1f1d; --ink: #ecebe6; --muted: #9a9993; --line: #33322f; --accent: #8f83f0; --accent-ink: #12111c; --sel: #2b2846; --warn: #f0826c; }
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--ink); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
button, select, input { font: inherit; color: inherit; }
button { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 6px 12px; cursor: pointer; }
button:hover { border-color: var(--muted); }
button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
input, select { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px; }
input:focus, select:focus, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.hidden { display: none !important; }
#unlock { display: grid; place-items: center; height: 100%; padding: 16px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 28px; width: min(420px, 100%); }
.card h1 { font-size: 20px; margin: 0 0 4px; }
.card p { color: var(--muted); margin: 0 0 18px; }
.card input { width: 100%; margin-bottom: 10px; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.err { color: var(--warn); min-height: 1.4em; margin: 6px 0; }
.link { background: none; border: 0; color: var(--accent); padding: 0; }
#app { display: grid; grid-template-rows: auto 1fr; height: 100%; }
header { display: flex; gap: 10px; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--line); background: var(--panel); flex-wrap: wrap; }
header .title { font-weight: 600; margin-right: auto; }
main { display: grid; grid-template-columns: minmax(220px, 320px) 1fr; min-height: 0; }
#side { border-right: 1px solid var(--line); overflow: auto; padding: 8px 0; }
#side .filter { margin: 0 8px 8px; width: calc(100% - 16px); }
.tree { list-style: none; margin: 0; padding: 0; }
.tree .tree { padding-left: 14px; }
.item { display: flex; gap: 6px; padding: 3px 12px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-radius: 4px; margin: 0 4px; }
.item:hover { background: var(--sel); }
.item.active { background: var(--sel); font-weight: 600; }
.item .meta { color: var(--muted); margin-left: auto; font-size: 12px; }
.folder > .item::before { content: "▸"; color: var(--muted); }
.folder.open > .item::before { content: "▾"; }
.folder:not(.open) > .tree { display: none; }
#view { overflow: auto; padding: 20px 24px; min-width: 0; }
#view h2 { margin: 0 0 6px; font-size: 18px; word-break: break-all; }
.muted { color: var(--muted); }
.versions { display: flex; gap: 6px; flex-wrap: wrap; margin: 14px 0; }
.chip { border: 1px solid var(--line); border-radius: 999px; padding: 3px 10px; cursor: pointer; background: var(--panel); font-size: 13px; }
.chip.active { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
pre.content { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px; white-space: pre-wrap; word-break: break-word; font-family: var(--mono); font-size: 13px; }
img.content, video.content { max-width: 100%; border-radius: 8px; border: 1px solid var(--line); }
iframe.content { width: 100%; height: 70vh; border: 1px solid var(--line); border-radius: 8px; }
.empty { color: var(--muted); padding: 40px 0; text-align: center; }
@media (max-width: 720px) {
  main { grid-template-columns: 1fr; grid-template-rows: 40vh 1fr; }
  #side { border-right: 0; border-bottom: 1px solid var(--line); }
}
</style>
</head>
<body>
<section id="unlock">
  <form class="card" id="unlockForm">
    <h1>Unlock vault</h1>
    <p id="repoPath">Read-only. Nothing in the repository is changed.</p>
    <input id="pw" type="password" placeholder="Vault password" autocomplete="off" autofocus>
    <input id="rk" class="hidden" placeholder="EGR1-XXXX-XXXX-…" autocomplete="off" spellcheck="false">
    <div class="err" id="unlockErr"></div>
    <div class="row">
      <button class="primary" type="submit" id="unlockBtn">Unlock</button>
      <button class="link" type="button" id="toggleRk">Use recovery key instead</button>
    </div>
  </form>
</section>

<section id="app" class="hidden">
  <header>
    <span class="title">Encgidian Decrypter</span>
    <label class="muted" for="snap">Sync</label>
    <select id="snap" aria-label="Snapshot"></select>
    <button id="deletedBtn">Deleted files</button>
    <button id="exportBtn">Export this sync…</button>
  </header>
  <main>
    <nav id="side" aria-label="Files">
      <input class="filter" id="filter" placeholder="Filter files" aria-label="Filter files">
      <ul class="tree" id="tree"></ul>
    </nav>
    <article id="view"><div class="empty">Choose a file on the left.</div></article>
  </main>
</section>

<script>
const token = new URLSearchParams(location.hash.slice(1)).get("t") || "";
const $ = (id) => document.getElementById(id);
const api = async (path, opts = {}) => {
  const r = await fetch(path, { ...opts, headers: { "x-token": token, "content-type": "application/json", ...(opts.headers || {}) } });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r;
};
const fmt = (secs) => { const d = new Date(secs * 1000); return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }); };
const size = (n) => n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB";
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let commits = [], files = [], current = null, mode = "files", deleted = [], blobUrl = null;

$("toggleRk").onclick = () => {
  const rk = $("rk").classList.toggle("hidden");
  $("pw").classList.toggle("hidden", !rk);
  $("toggleRk").textContent = rk ? "Use recovery key instead" : "Use password instead";
  (rk ? $("pw") : $("rk")).focus();
};
$("unlockForm").onsubmit = async (e) => {
  e.preventDefault();
  $("unlockErr").textContent = "";
  $("unlockBtn").disabled = true;
  $("unlockBtn").textContent = "Unlocking…";
  try {
    const useRk = !$("rk").classList.contains("hidden");
    await api("/api/unlock", { method: "POST", body: JSON.stringify(useRk ? { recoveryKey: $("rk").value } : { password: $("pw").value }) });
    await start();
  } catch (err) { $("unlockErr").textContent = err.message; }
  $("unlockBtn").disabled = false;
  $("unlockBtn").textContent = "Unlock";
};

async function start() {
  $("unlock").classList.add("hidden");
  $("app").classList.remove("hidden");
  commits = await (await api("/api/commits")).json();
  $("snap").innerHTML = commits.map((c, i) => '<option value="' + c.oid + '">' + fmt(c.time) + (i === 0 ? " (latest)" : "") + "</option>").join("");
  await loadSnapshot();
}
$("snap").onchange = () => { mode = "files"; loadSnapshot(); };
$("filter").oninput = () => render();

async function loadSnapshot() {
  files = await (await api("/api/snapshot?c=" + $("snap").value)).json();
  mode = "files";
  $("deletedBtn").textContent = "Deleted files";
  render();
  if (current && files.some((f) => f.path === current)) openFile(current);
  else $("view").innerHTML = '<div class="empty">' + files.length + " files in this sync. Choose one on the left.</div>";
}

$("deletedBtn").onclick = async () => {
  if (mode === "deleted") return loadSnapshot();
  $("view").innerHTML = '<div class="empty">Searching the history…</div>';
  deleted = await (await api("/api/deleted")).json();
  mode = "deleted";
  $("deletedBtn").textContent = "Back to files";
  render();
  $("view").innerHTML = '<div class="empty">' + deleted.length + " deleted file(s). Each shows its last version before deletion.</div>";
};

function render() {
  const q = $("filter").value.toLowerCase();
  const list = (mode === "files" ? files : deleted).filter((f) => f.path.toLowerCase().includes(q));
  if (mode === "deleted") {
    $("tree").innerHTML = list.map((f) => '<li><div class="item" data-p="' + esc(f.path) + '" title="' + esc(f.path) + '">' + esc(f.path) + '<span class="meta">' + fmt(f.time).split(",")[0] + "</span></div></li>").join("") || '<li class="empty">None</li>';
  } else {
    const root = {};
    for (const f of list) {
      const parts = f.path.split("/");
      let n = root;
      parts.slice(0, -1).forEach((p) => (n = n[p + "/"] ??= {}));
      n[parts.at(-1)] = f;
    }
    const open = q.length > 0;
    const build = (n, prefix) => Object.keys(n).sort((a, b) => (b.endsWith("/") - a.endsWith("/")) || a.localeCompare(b)).map((k) =>
      k.endsWith("/")
        ? '<li class="folder' + (open ? " open" : "") + '"><div class="item">' + esc(k.slice(0, -1)) + '</div><ul class="tree">' + build(n[k], prefix + k) + "</ul></li>"
        : '<li><div class="item' + (n[k].path === current ? " active" : "") + '" data-p="' + esc(n[k].path) + '" title="' + esc(n[k].path) + '">' + esc(k) + '<span class="meta">' + size(n[k].size) + "</span></div></li>"
    ).join("");
    $("tree").innerHTML = build(root, "") || '<li class="empty">No files</li>';
  }
}
$("tree").onclick = (e) => {
  const it = e.target.closest(".item");
  if (!it) return;
  if (!it.dataset.p) return it.parentElement.classList.toggle("open");
  document.querySelectorAll(".item.active").forEach((x) => x.classList.remove("active"));
  it.classList.add("active");
  openFile(it.dataset.p);
};

async function openFile(p) {
  current = p;
  $("view").innerHTML = '<h2></h2><div class="muted" id="sub">Loading versions…</div><div class="versions" id="vers"></div><div class="row" id="acts"></div><div id="content"></div>';
  $("view").querySelector("h2").textContent = p;
  const vs = await (await api("/api/versions?path=" + encodeURIComponent(p))).json();
  $("sub").textContent = vs.length + " version" + (vs.length === 1 ? "" : "s") + " in the history";
  $("vers").innerHTML = vs.map((v, i) => '<button class="chip" data-i="' + i + '" title="' + esc(v.device) + " · " + size(v.size) + '">' + fmt(v.time) + "</button>").join("");
  $("vers").onclick = (e) => { const b = e.target.closest(".chip"); if (b) showVersion(p, vs, Number(b.dataset.i)); };
  // Pick the version that this snapshot holds (or the newest).
  let idx = 0;
  if (mode === "files") {
    const snapTime = (commits.find((c) => c.oid === $("snap").value) || commits[0]).time;
    idx = Math.max(0, vs.findIndex((v) => v.time <= snapTime));
  }
  if (vs.length) showVersion(p, vs, idx);
}

async function showVersion(p, vs, i) {
  document.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", Number(c.dataset.i) === i));
  const v = vs[i];
  const url = "/api/raw?path=" + encodeURIComponent(p) + "&obj=" + v.obj;
  $("acts").innerHTML = '<span class="muted">Saved by ' + esc(v.device) + " · " + size(v.size) + '</span> <button id="dl">Download</button>';
  $("dl").onclick = async () => {
    const blob = await (await api(url + "&download=1")).blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = p.split("/").pop();
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  const r = await api(url);
  const type = r.headers.get("content-type") || "";
  const blob = await r.blob();
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  blobUrl = URL.createObjectURL(blob);
  const c = $("content");
  if (type.startsWith("image/")) c.innerHTML = '<img class="content" alt="">', c.firstChild.src = blobUrl;
  else if (type.startsWith("video/") || type.startsWith("audio/")) c.innerHTML = '<video class="content" controls></video>', c.firstChild.src = blobUrl;
  else if (type === "application/pdf") c.innerHTML = '<iframe class="content" sandbox></iframe>', c.firstChild.src = blobUrl;
  else {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const text = new TextDecoder().decode(buf.subarray(0, 2e6));
    c.innerHTML = "";
    if (/[\\u0000-\\u0008]/.test(text.slice(0, 4000))) c.innerHTML = '<div class="empty">Binary file. Use Download to save it.</div>';
    else { const pre = document.createElement("pre"); pre.className = "content"; pre.textContent = text; c.appendChild(pre); }
  }
}

$("exportBtn").onclick = async () => {
  const info = await (await api("/api/info")).json();
  const dir = prompt("Export every file of this sync to which folder?", info.defaultExport);
  if (!dir) return;
  try {
    const r = await (await api("/api/export", { method: "POST", body: JSON.stringify({ c: $("snap").value, dir }) })).json();
    alert("Exported " + r.count + " files to " + r.dir + (r.skipped && r.skipped.length ? "\n\nSkipped " + r.skipped.length + " large file(s) this clone doesn't include. Clone with git clone --mirror to get them." : ""));
  } catch (e) { alert("Export failed: " + e.message); }
};

(async () => {
  try {
    const info = await (await api("/api/info")).json();
    $("repoPath").textContent = info.repo + " — read-only, nothing in it is changed.";
    if (info.unlocked) start();
  } catch (e) { $("unlockErr").textContent = "This page must be opened from the link the decrypter printed. " + e.message; }
})();
</script>
</body>
</html>`;
