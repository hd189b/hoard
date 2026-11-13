// Simulated desktop for stress tests. Usage: bun test/e2e/pc.ts <dir> <password> <cmd> [args]
//   bulk <folder> <count> [bytes]   create notes;  big <path> <MB>   create a large file
//   edit <count>                    change <count> existing notes;  sync;  hashes
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { Device } from "../helpers/device";

const [dir, password, cmd, a, b, c] = process.argv.slice(2);
const servers = [47201, 47202].map((p) => ({ url: () => `http://127.0.0.1:${p}/vault.git` }));
const d = new Device("PC", dir, { servers, password, creds: { password: "e2e-token-123" } });
const t0 = Date.now();
if (cmd === "bulk") {
  for (let i = 0; i < Number(b); i++) d.put(`${a}/n-${String(i).padStart(5, "0")}.md`, `# ${a} ${i}\n` + "lorem ipsum ".repeat(Math.max(1, Number(c ?? 200) / 12)));
  console.log(`created ${b} notes in ${a}`);
} else if (cmd === "big") {
  const p = path.join(d.vaultDir, a);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, crypto.randomBytes(Number(b) * 1024 * 1024));
  console.log(`created ${a} (${b} MB)`);
} else if (cmd === "edit") {
  const files = Object.keys(d.files()).filter((f) => f.endsWith(".md"));
  for (let i = 0; i < Number(a); i++) {
    const f = files[Math.floor(Math.random() * files.length)];
    fs.appendFileSync(path.join(d.vaultDir, f), `\nedit ${Date.now()}-${i}`);
    fs.utimesSync(path.join(d.vaultDir, f), new Date(), new Date(Date.now() + i));
  }
  console.log(`edited ${a} notes`);
} else if (cmd === "sync") {
  const r = await d.sync();
  console.log(JSON.stringify({ secs: (Date.now() - t0) / 1000, applied: r.applied, committed: r.committedLocal, conflicts: r.conflicts.length, hosts: r.remotes.map((x) => (x.upToDate ? "ok" : x.error)) }));
} else if (cmd === "hashes") {
  const out: Record<string, string> = {};
  const walk = (dd: string, rel: string) => {
    for (const e of fs.readdirSync(dd, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === ".obsidian" || e.name === ".trash") continue;
      if (e.isDirectory()) walk(path.join(dd, e.name), r);
      else out[r] = crypto.createHash("sha256").update(fs.readFileSync(path.join(dd, e.name))).digest("hex").slice(0, 12);
    }
  };
  walk(d.vaultDir, "");
  console.log(JSON.stringify(out));
}
