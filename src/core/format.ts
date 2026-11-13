// Repository format: file IDs, encrypted file objects and encrypted manifest shards.
//
// Repo layout (every commit):
//   keys.json        wrapped vault key + KDF parameters (no secrets)
//   m/<xx>           encrypted manifest shard xx (00..ff), absent when empty
//   o/<xx>/<id>      encrypted file contents, id = HMAC(names, path)

import { concat, fromUtf8, toHex, utf8, bytesEqual } from "./bytes";
import { DecryptError, gcmDecrypt, gcmEncrypt, hmac } from "./crypto";
import type { VaultKeys } from "./keys";

export const BRANCH = "main";

/**
 * Transfer limits. Obsidian for Android crashes on single downloads somewhere
 * above ~20 MB, so no Git transfer should carry much more than this:
 *  - files whose encrypted form is larger than LARGE_OBJECT_BYTES are stored outside
 *    the main history, each under its own ref (refs/encgidian/large/<blob id>), and a
 *    device only downloads one if its own size limit allows;
 *  - whenever about STEP_BYTES of new data has piled up, a "step" ref marks that point
 *    in history (refs/encgidian/steps/<time>-<random>), so a device that is far behind
 *    can download history in pieces.
 */
export const LARGE_OBJECT_BYTES = 8 * 1024 * 1024;
export const STEP_BYTES = 8 * 1024 * 1024;
export const STEP_PREFIX = "refs/encgidian/steps/";
export const LARGE_PREFIX = "refs/encgidian/large/";
/** Each device's scratch ref used to upload history one bounded piece at a time. */
export const UPLOAD_PREFIX = "refs/encgidian/upload/";
const OBJ_MAGIC = utf8("EGO1");
const SHARD_MAGIC = utf8("EGM1");

/** A file as recorded in the manifest. */
export interface Entry {
  /** Vault-relative path, "/" separators, NFC. */
  p: string;
  /** File id (HMAC of path), hex. */
  i: string;
  /** Plaintext size in bytes. */
  s: number;
  /** Modified time, ms since epoch. */
  t: number;
  /** HMAC of the plaintext, hex. Equal hash = equal content. */
  h: string;
  /** Device that last changed it. */
  d: string;
  /** Git blob id of the encrypted object. */
  o: string;
  /** Set when the object is stored under its own ref instead of the main history. */
  L?: 1;
}

export type Manifest = Map<string, Entry>;

export class FormatError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "FormatError";
  }
}

export function normalizePath(p: string): string {
  let s = p.normalize("NFC").replace(/\\/g, "/");
  s = s.replace(/^(\.\/)+/, "").replace(/^\/+/, "").replace(/\/+/g, "/").replace(/\/$/, "");
  if (!s || s.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) {
    throw new FormatError(`Invalid path: ${JSON.stringify(p)}`);
  }
  return s;
}

export async function fileId(keys: VaultKeys, path: string): Promise<string> {
  return toHex(await hmac(keys.names, utf8("path:" + path))).slice(0, 32);
}

export const shardOf = (id: string) => id.slice(0, 2);

export async function contentHash(keys: VaultKeys, data: Uint8Array): Promise<string> {
  return toHex(await hmac(keys.hash, data));
}

const objAad = (id: string, path: string) => utf8(`encgidian:v1:obj:${id}:${path}`);
const shardAad = (shard: string) => utf8(`encgidian:v1:shard:${shard}`);

export async function encryptObject(keys: VaultKeys, path: string, id: string, data: Uint8Array): Promise<Uint8Array> {
  return concat(OBJ_MAGIC, await gcmEncrypt(keys.content, data, objAad(id, path)));
}

export async function decryptObject(keys: VaultKeys, path: string, id: string, blob: Uint8Array): Promise<Uint8Array> {
  if (!bytesEqual(blob.subarray(0, 4), OBJ_MAGIC)) throw new FormatError(`Not an encrypted file object (${path})`);
  try {
    return await gcmDecrypt(keys.content, blob.subarray(4), objAad(id, path));
  } catch (e) {
    if (e instanceof DecryptError) {
      throw new DecryptError(`Could not decrypt "${path}": the data is damaged or belongs to another file`);
    }
    throw e;
  }
}

/** Stable text form of a shard, used to tell whether a shard changed. */
export function canonicalShard(entries: Entry[]): string {
  const sorted = [...entries].sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
  return JSON.stringify(sorted.map((e) => (e.L ? [e.p, e.i, e.s, e.t, e.h, e.d, e.o, 1] : [e.p, e.i, e.s, e.t, e.h, e.d, e.o])));
}

export async function encryptShard(keys: VaultKeys, shard: string, canonical: string): Promise<Uint8Array> {
  const body = utf8(JSON.stringify({ v: 1, e: JSON.parse(canonical) }));
  return concat(SHARD_MAGIC, await gcmEncrypt(keys.manifest, body, shardAad(shard)));
}

export async function decryptShard(keys: VaultKeys, shard: string, blob: Uint8Array): Promise<Entry[]> {
  if (!bytesEqual(blob.subarray(0, 4), SHARD_MAGIC)) throw new FormatError(`Not a manifest shard (${shard})`);
  let pt: Uint8Array;
  try {
    pt = await gcmDecrypt(keys.manifest, blob.subarray(4), shardAad(shard));
  } catch (e) {
    if (e instanceof DecryptError) throw new DecryptError(`Manifest shard ${shard} is damaged or from another vault`);
    throw e;
  }
  const doc = JSON.parse(fromUtf8(pt));
  if (doc.v !== 1 || !Array.isArray(doc.e)) throw new FormatError(`Unsupported manifest shard format (${shard})`);
  return doc.e.map((r: unknown[]) => {
    const [p, i, s, t, h, d, o, l] = r as [string, string, number, number, string, string, string, number?];
    if (shardOf(i) !== shard) throw new FormatError(`Manifest shard ${shard} holds an entry for another shard`);
    const e: Entry = { p, i, s, t, h, d, o };
    if (l === 1) e.L = 1;
    return e;
  });
}
