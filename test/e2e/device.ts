// A second simulated device for end-to-end tests against the local servers.
// Usage: bun test/e2e/device.ts <dir> <password> sync | put <path> <text> | del <path> | ls
import { Device } from "../helpers/device";

const [dir, password, cmd, a, b] = process.argv.slice(2);
const servers = [47201, 47202].map((p) => ({ url: () => `http://127.0.0.1:${p}/vault.git` }));
const d = new Device("Phone", dir, { servers, password, creds: { password: "e2e-token-123" } });
if (cmd === "put") d.put(a, b);
else if (cmd === "del") d.del(a);
else if (cmd === "ls") console.log(JSON.stringify(d.files(), null, 1));
else if (cmd === "sync") {
  const r = await d.sync();
  console.log(JSON.stringify({ applied: r.applied, committed: r.committedLocal, conflicts: r.conflicts, remotes: r.remotes.map((x) => [x.name, x.upToDate, x.error ?? ""]) }));
}
