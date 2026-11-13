import { describe, expect, it } from "vitest";
import { fromUtf8, utf8 } from "../src/core/bytes";
import { DecryptError } from "../src/core/crypto";
import {
  changePassword,
  createKeyFile,
  formatRecoveryKey,
  parseKeyFile,
  parseRecoveryKey,
  serializeKeyFile,
  unlockWithPassword,
  unlockWithRawKey,
  WrongPasswordError,
} from "../src/core/keys";
import {
  canonicalShard,
  contentHash,
  decryptObject,
  decryptShard,
  encryptObject,
  encryptShard,
  Entry,
  fileId,
  normalizePath,
} from "../src/core/format";
import { conflictName, safePath, uniqueName, clashKey } from "../src/core/names";
import { merge3 } from "../src/core/merge";

export const FAST = { memoryKiB: 1024, iterations: 1, parallelism: 1 };

describe("keys", () => {
  it("creates, unlocks, rejects wrong password", async () => {
    const { keyFile, keys } = await createKeyFile("correct horse", FAST);
    const kf = parseKeyFile(serializeKeyFile(keyFile));
    const k2 = await unlockWithPassword(kf, "correct horse");
    expect(k2.vaultId).toBe(keys.vaultId);
    await expect(unlockWithPassword(kf, "wrong")).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it("changes password without changing the vault key", async () => {
    const { keyFile, keys } = await createKeyFile("old", FAST);
    const kf2 = await changePassword(keyFile, keys, "new");
    await expect(unlockWithPassword(kf2, "old")).rejects.toBeInstanceOf(WrongPasswordError);
    const k = await unlockWithPassword(kf2, "new");
    expect(Buffer.from(k.exportRaw())).toEqual(Buffer.from(keys.exportRaw()));
  });

  it("recovery key round-trips and is checked against the vault", async () => {
    const { keyFile, keys } = await createKeyFile("pw", FAST);
    const rk = formatRecoveryKey(keys);
    expect(rk).toMatch(/^EGR1-[A-Z2-7]{4}(-[A-Z2-7]{1,4})+$/);
    const k = await unlockWithRawKey(keyFile, parseRecoveryKey(rk.toLowerCase()));
    expect(k.vaultId).toBe(keys.vaultId);
    const other = await createKeyFile("pw", FAST);
    await expect(unlockWithRawKey(other.keyFile, parseRecoveryKey(rk))).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it("refuses foreign files", () => {
    expect(() => parseKeyFile('{"format":"x"}')).toThrow(/not an encgidian vault/);
  });
});

describe("format", () => {
  it("binds the path into file encryption", async () => {
    const { keys } = await createKeyFile("pw", FAST);
    const a = "notes/a.md";
    const b = "notes/b.md";
    const ia = await fileId(keys, a);
    const ib = await fileId(keys, b);
    expect(ia).toMatch(/^[0-9a-f]{32}$/);
    expect(ia).not.toBe(ib);
    const blob = await encryptObject(keys, a, ia, utf8("secret text"));
    expect(fromUtf8(await decryptObject(keys, a, ia, blob))).toBe("secret text");
    // Swapping a's encrypted object into b's place fails.
    await expect(decryptObject(keys, b, ib, blob)).rejects.toBeInstanceOf(DecryptError);
    expect(Buffer.from(blob).includes(Buffer.from("secret"))).toBe(false);
  });

  it("encrypts shards and refuses shard swaps", async () => {
    const { keys } = await createKeyFile("pw", FAST);
    const id = await fileId(keys, "x.md");
    const e: Entry = { p: "x.md", i: id, s: 3, t: 1, h: await contentHash(keys, utf8("abc")), d: "PC", o: "0".repeat(40) };
    const shard = id.slice(0, 2);
    const blob = await encryptShard(keys, shard, canonicalShard([e]));
    expect(await decryptShard(keys, shard, blob)).toEqual([e]);
    const other = shard === "00" ? "01" : "00";
    await expect(decryptShard(keys, other, blob)).rejects.toBeInstanceOf(DecryptError);
  });

  it("normalizes paths", () => {
    expect(normalizePath("./a\\b//c.md")).toBe("a/b/c.md");
    expect(() => normalizePath("a/../b")).toThrow();
  });
});

describe("names", () => {
  it("adds (n) like a browser", () => {
    const taken = new Set(["note.md", "note (1).md"].map(clashKey));
    expect(uniqueName("note.md", taken)).toBe("note (2).md");
    expect(uniqueName("Note.md", new Set(["note.md"]))).toBe("Note (1).md");
    expect(uniqueName("free.md", taken)).toBe("free.md");
    expect(uniqueName("dir/a (3).md", new Set(["dir/a (3).md"]))).toBe("dir/a (4).md");
  });
  it("builds conflict names", () => {
    expect(conflictName("d/Plan.md", "Phone", new Date(2026, 10, 13, 22, 15))).toBe(
      "d/Plan (conflict 2026-11-13 2215 Phone).md",
    );
  });
  it("makes names safe for Windows", () => {
    expect(safePath('a:b/c*d?.md')).toBe("a_b/c_d_.md");
    expect(safePath("CON.md")).toBe("_CON.md");
    expect(safePath("dir./x")).toBe("dir_/x");
  });
});

const E = (p: string, h: string, d = "x"): Entry => ({ p, i: p, s: 1, t: 1, h, d, o: h });
const M = (...es: Entry[]) => new Map(es.map((e) => [e.p, e]));
const opts = { device: "Phone", now: new Date(2026, 10, 13, 22, 15) };

describe("merge3", () => {
  it("takes one-sided changes", () => {
    const base = M(E("a", "1"), E("b", "1"), E("c", "1"));
    const ours = M(E("a", "2"), E("b", "1"), E("d", "1"));
    const theirs = M(E("a", "1"), E("b", "3"), E("c", "1"), E("e", "1"));
    const r = merge3(base, ours, theirs, opts);
    expect([...r.result.keys()].sort()).toEqual(["a", "b", "d", "e"]);
    expect(r.result.get("a")!.h).toBe("2");
    expect(r.result.get("b")!.h).toBe("3");
    expect(r.conflicts).toEqual([]);
  });

  it("keeps both versions when both edited", () => {
    const r = merge3(M(E("Plan.md", "A")), M(E("Plan.md", "C")), M(E("Plan.md", "B")), opts);
    expect(r.result.get("Plan.md")!.h).toBe("B");
    const copy = "Plan (conflict 2026-11-13 2215 Phone).md";
    expect(r.result.get(copy)!.h).toBe("C");
    expect(r.result.get(copy)!.p).toBe("Plan.md"); // needs re-encryption under new path
    expect(r.conflicts).toEqual([{ path: "Plan.md", copy, kind: "both-edited" }]);
  });

  it("same edit on both sides is not a conflict", () => {
    const r = merge3(M(E("a", "1")), M(E("a", "2")), M(E("a", "2")), opts);
    expect(r.conflicts).toEqual([]);
    expect(r.result.get("a")!.h).toBe("2");
  });

  it("delete vs edit keeps the edit, both ways", () => {
    expect(merge3(M(E("a", "1")), M(), M(E("a", "2")), opts).result.get("a")!.h).toBe("2");
    expect(merge3(M(E("a", "1")), M(E("a", "2")), M(), opts).result.get("a")!.h).toBe("2");
    expect(merge3(M(E("a", "1")), M(), M(E("a", "1")), opts).result.has("a")).toBe(false);
  });

  it("both added with different content -> conflict", () => {
    const r = merge3(M(), M(E("n.md", "1")), M(E("n.md", "2")), opts);
    expect(r.result.get("n.md")!.h).toBe("2");
    expect(r.conflicts[0].kind).toBe("both-added");
  });

  it("an edit follows a rename on the other side", () => {
    const base = M(E("old.md", "1"));
    const ours = M(E("new.md", "1")); // renamed
    const theirs = M(E("old.md", "2")); // edited
    const r = merge3(base, ours, theirs, opts);
    expect([...r.result.keys()]).toEqual(["new.md"]);
    expect(r.result.get("new.md")!.h).toBe("2");
    const r2 = merge3(base, theirs, ours, opts);
    expect([...r2.result.keys()]).toEqual(["new.md"]);
    expect(r2.result.get("new.md")!.h).toBe("2");
  });

  it("renames names that differ only by case", () => {
    const r = merge3(M(), M(E("note.md", "1")), M(E("Note.md", "2")), opts);
    expect(r.result.get("Note.md")!.h).toBe("2");
    expect(r.result.get("note (1).md")!.h).toBe("1");
    expect(r.clashes).toEqual([{ from: "note.md", to: "note (1).md" }]);
  });

  it("never loses content", () => {
    // Randomized: every content hash present in ours or theirs (changed vs base) survives.
    for (let n = 0; n < 300; n++) {
      const rnd = (k: number) => Math.floor(Math.random() * k);
      const paths = ["a", "b", "c", "A", "d/e"];
      const mk = () => M(...paths.filter(() => rnd(3) > 0).map((p) => E(p, String(rnd(3)))));
      const base = mk();
      const ours = mk();
      const theirs = mk();
      const r = merge3(base, ours, theirs, opts);
      const out = new Set([...r.result.values()].map((e) => `${e.h}`));
      // Content that already existed in base (anywhere) may legitimately go away
      // through a delete or rename; any new content must survive.
      const baseHashes = new Set([...base.values()].map((e) => e.h));
      for (const side of [ours, theirs]) {
        for (const [p, e] of side) {
          if (!baseHashes.has(e.h)) expect(out.has(e.h), `lost ${p}=${e.h}`).toBe(true);
        }
      }
      const keys = [...r.result.keys()].map(clashKey);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});
