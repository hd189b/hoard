// Two local Git servers for manual / Obsidian end-to-end testing.
// Usage: bun test/e2e/servers.ts <root> ; control: touch <root>/s1.down to take server 1 down.
import * as fs from "fs";
import * as path from "path";
import { GitServer } from "../helpers/gitserver";

const root = process.argv[2];
const servers = [new GitServer(path.join(root, "s1")), new GitServer(path.join(root, "s2"))];
for (const [i, s] of servers.entries()) {
  if (!fs.existsSync(path.join(root, `s${i + 1}`, "vault.git"))) s.createRepo();
  s.auth = { username: "x-access-token", password: "e2e-token-123" };
  await s.start(47201 + i);
  console.log(`server ${i + 1}: ${s.url()}`);
}
setInterval(() => servers.forEach((s, i) => (s.down = fs.existsSync(path.join(root, `s${i + 1}.down`)))), 200);
