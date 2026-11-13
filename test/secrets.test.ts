// Linux secret backends, using fake `secret-tool`, `kwallet-query` and `dbus-send`
// on PATH so the real desktop keyrings are never touched.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { detectLinuxBackends, linuxStore, pickDefault, PlaintextStore } from "../src/platform/secrets-linux";
import { moveSecrets } from "../src/core/secrets";

let tmp: string;
let oldPath: string | undefined;

function fake(name: string, body: string) {
  const p = path.join(tmp, "bin", name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

/** Simulate a session: which program owns org.freedesktop.secrets, and which bus names exist. */
function session(o: { owner?: string; names?: string[]; secretTool?: boolean; kwallet?: boolean; wallets?: string[] }) {
  fs.rmSync(path.join(tmp, "bin"), { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, "bin"));
  for (const b of ["sh", "cat", "grep", "printf", "sed", "rm", "mkdir", "touch", "test", "["]) {
    const real = ["/usr/bin", "/bin"].map((d) => path.join(d, b)).find((x) => fs.existsSync(x));
    if (real) fs.symlinkSync(real, path.join(tmp, "bin", b));
  }
  const store = path.join(tmp, "store");
  fs.mkdirSync(store, { recursive: true });
  const ownerPid = o.owner ? String(process.pid) : "";
  fake(
    "dbus-send",
    `case "$*" in
  *GetConnectionUnixProcessID*) ${ownerPid ? `echo "   uint32 ${ownerPid}"` : 'echo "Error NameHasNoOwner" >&2; exit 1'} ;;
  *ListNames*|*ListActivatableNames*) for n in ${(o.names ?? []).join(" ")}; do echo "      string \\"$n\\""; done ;;
  *KWallet.wallets*) ${o.names?.some((n) => n.includes("kwalletd")) ? "" : "exit 1;"} echo "   array ["; for w in ${(o.wallets ?? ["kdewallet"]).join(" ")}; do echo "      string \\"$w\\""; done; echo "   ]" ;;
esac`,
  );
  if (o.secretTool) {
    fake(
      "secret-tool",
      `cmd=$1; shift; key=""; while [ $# -gt 0 ]; do case "$1" in account) key=$2; shift;; esac; shift; done
f="${store}/st_$(printf %s "$key" | sed 's/[^a-zA-Z0-9]/_/g')"
case $cmd in store) cat > "$f";; lookup) test -f "$f" && cat "$f" || exit 1;; clear) rm -f "$f";; esac`,
    );
  }
  if (o.kwallet) {
    fake(
      "kwallet-query",
      `mode=$3; key=$4; f="${store}/kw_$(printf %s "$key" | sed 's/[^a-zA-Z0-9]/_/g')"
case $mode in -w) cat > "$f";; -r) test -f "$f" && cat "$f" || { echo "Failed to read entry $key value from the kdewallet wallet." >&2; exit 1; };; esac`,
    );
  }
  process.env.PATH = path.join(tmp, "bin");
  // Pretend the Secret Service owner's process name.
  return o.owner;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "egk-"));
  oldPath = process.env.PATH;
});
afterEach(() => {
  process.env.PATH = oldPath;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("Linux secret backend detection order", () => {
  it("picks KeePassXC first when it provides the Secret Service", async () => {
    session({ owner: "keepassxc", names: ["org.kde.kwalletd6"], secretTool: true, kwallet: true });
    const d = await detectLinuxBackends(() => "keepassxc");
    expect(d.available).toEqual(["keepassxc", "kwallet", "plaintext"]);
    expect(pickDefault(d)).toBe("keepassxc");
  });

  it("treats another Secret Service owner as GNOME Keyring", async () => {
    session({ owner: "gnome-keyring-d", secretTool: true });
    const d = await detectLinuxBackends(() => "gnome-keyring-d");
    expect(d.available).toEqual(["gnome", "plaintext"]);
  });

  it("prefers KWallet, then Secret Service, then plain text when KeePassXC isn't running", async () => {
    session({ names: ["org.kde.kwalletd6", "org.freedesktop.secrets"], secretTool: true, kwallet: true });
    const d = await detectLinuxBackends();
    expect(d.available).toEqual(["kwallet", "gnome", "plaintext"]);
    expect(pickDefault(d)).toBe("kwallet");
  });

  it("falls back to plain text when nothing is available", async () => {
    session({});
    const d = await detectLinuxBackends();
    expect(d.available).toEqual(["plaintext"]);
    expect(pickDefault(d)).toBe("plaintext");
    expect(d.notes.keepassxc).toMatch(/KeePassXC/);
  });
});

describe("KWallet without a wallet", () => {
  it("isn't picked when no wallet exists yet, and says how to fix it", async () => {
    session({ names: ["org.kde.kwalletd6"], kwallet: true, wallets: [] });
    const d = await detectLinuxBackends();
    expect(d.available).toEqual(["plaintext"]);
    expect(d.kwalletNeedsWallet).toBe(true);
    expect(d.notes.kwallet).toMatch(/no wallet/);
  });

  it("doesn't mistake KWallet's own Secret Service (ksecretd) for GNOME Keyring", async () => {
    session({ owner: "ksecretd", names: ["org.kde.kwalletd6"], secretTool: true, kwallet: true, wallets: [] });
    const d = await detectLinuxBackends(() => "ksecretd");
    expect(d.available).toEqual(["plaintext"]);
    expect(d.notes.gnome).toMatch(/provided by KWallet/);
  });
});

describe("stores", () => {
  for (const kind of ["gnome", "kwallet"] as const) {
    it(`${kind}: set, get, delete`, async () => {
      session({ secretTool: true, kwallet: true });
      const s = linuxStore(kind, "abc");
      expect(await s.get("token")).toBeNull();
      await s.set("token", "s3cr3t value");
      expect(await s.get("token")).toBe("s3cr3t value");
      await s.delete("token");
      expect(await s.get("token")).toBeNull();
    });
  }

  it("plain text file is readable only by the user", async () => {
    const s = new PlaintextStore("ns1", path.join(tmp, "cfg"));
    await s.set("a", "b");
    expect(await s.get("a")).toBe("b");
    expect(fs.statSync(s.file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(s.file)).mode & 0o777).toBe(0o700);
  });

  it("moves secrets between backends", async () => {
    session({ secretTool: true, kwallet: true });
    const from = new PlaintextStore("ns", path.join(tmp, "cfg"));
    const to = linuxStore("kwallet", "ns");
    await from.set("vault-key", "K");
    await from.set("remote-1", "T");
    expect(await moveSecrets(from, to, ["vault-key", "remote-1", "missing"])).toBe(2);
    expect(await to.get("vault-key")).toBe("K");
    expect(await from.get("vault-key")).toBeNull();
  });
});
