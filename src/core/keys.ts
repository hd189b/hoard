// Vault key handling.
//
// The vault key is 32 random bytes made once per vault. It is stored in the
// repo only wrapped (AES-256-GCM) by a key derived from the password with
// Argon2id. Changing the password only re-wraps the vault key.

import { bytesEqual, fromB64, fromBase32, fromUtf8, toB64, toBase32, toHex, utf8 } from "./bytes";
import {
  aesKey,
  argon2Key,
  Argon2Params,
  DecryptError,
  DEFAULT_ARGON2,
  gcmDecrypt,
  gcmEncrypt,
  hkdf,
  hmac,
  hmacKey,
  randomBytes,
} from "./crypto";

export const KEYFILE_PATH = "keys.json";

export interface KeyFile {
  format: "encgidian-keys";
  version: 1;
  /** Random id, the same on every host of one vault. Used to refuse mixing vaults. */
  vaultId: string;
  kdf: { alg: "argon2id"; salt: string } & Argon2Params;
  /** b64(iv || AES-GCM(passwordKey, vaultKey)) */
  wrappedKey: string;
  /** b64(HMAC(checkKey, vaultId)), lets a recovery key be verified. */
  keyCheck: string;
}

export class WrongPasswordError extends Error {
  constructor(msg = "Wrong password") {
    super(msg);
    this.name = "WrongPasswordError";
  }
}

export class KeyFileError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "KeyFileError";
  }
}

const wrapAad = (vaultId: string) => utf8(`encgidian:v1:keys:${vaultId}`);

/** All sub-keys derived from the vault key. */
export class VaultKeys {
  private constructor(
    readonly vaultId: string,
    readonly content: CryptoKey,
    readonly manifest: CryptoKey,
    readonly names: CryptoKey,
    readonly hash: CryptoKey,
    private readonly raw: Uint8Array,
  ) {}

  static async derive(vaultKey: Uint8Array, vaultId: string): Promise<VaultKeys> {
    if (vaultKey.length !== 32) throw new KeyFileError("Vault key must be 32 bytes");
    const salt = utf8(`encgidian:v1:${vaultId}`);
    const [c, m, n, h] = await Promise.all([
      hkdf(vaultKey, "content", salt),
      hkdf(vaultKey, "manifest", salt),
      hkdf(vaultKey, "names", salt),
      hkdf(vaultKey, "hash", salt),
    ]);
    return new VaultKeys(vaultId, await aesKey(c), await aesKey(m), await hmacKey(n), await hmacKey(h), vaultKey.slice());
  }

  /** The raw vault key, for remembering on this device or showing as a recovery key. */
  exportRaw(): Uint8Array {
    return this.raw.slice();
  }

  /** Overwrite the copy of the raw key held by this object. */
  wipe(): void {
    this.raw.fill(0);
  }
}

async function keyCheck(vaultKey: Uint8Array, vaultId: string): Promise<string> {
  const k = await hmacKey(await hkdf(vaultKey, "check", utf8(`encgidian:v1:${vaultId}`)));
  return toB64(await hmac(k, utf8(vaultId)));
}

export function parseKeyFile(data: Uint8Array | string): KeyFile {
  let kf: KeyFile;
  try {
    kf = JSON.parse(typeof data === "string" ? data : fromUtf8(data));
  } catch {
    throw new KeyFileError("keys.json is not valid JSON");
  }
  if (kf?.format !== "encgidian-keys") throw new KeyFileError("This repository is not an encgidian vault");
  if (kf.version !== 1) throw new KeyFileError(`Unsupported vault format version ${kf.version}; update the plugin`);
  if (kf.kdf?.alg !== "argon2id") throw new KeyFileError("Unsupported key derivation");
  if (typeof kf.vaultId !== "string" || !/^[0-9a-f]{32}$/.test(kf.vaultId)) throw new KeyFileError("Bad vault id");
  return kf;
}

export function serializeKeyFile(kf: KeyFile): Uint8Array {
  return utf8(JSON.stringify(kf, null, 2) + "\n");
}

async function wrap(vaultKey: Uint8Array, vaultId: string, password: string, params: Argon2Params) {
  const salt = randomBytes(16);
  const pk = await aesKey(await argon2Key(password, salt, params));
  const wrapped = await gcmEncrypt(pk, vaultKey, wrapAad(vaultId));
  return { salt: toB64(salt), wrappedKey: toB64(wrapped) };
}

export async function createKeyFile(
  password: string,
  params: Argon2Params = DEFAULT_ARGON2,
): Promise<{ keyFile: KeyFile; keys: VaultKeys }> {
  if (!password) throw new KeyFileError("Password must not be empty");
  const vaultKey = randomBytes(32);
  const vaultId = toHex(randomBytes(16));
  const w = await wrap(vaultKey, vaultId, password, params);
  const keyFile: KeyFile = {
    format: "encgidian-keys",
    version: 1,
    vaultId,
    kdf: { alg: "argon2id", salt: w.salt, ...params },
    wrappedKey: w.wrappedKey,
    keyCheck: await keyCheck(vaultKey, vaultId),
  };
  return { keyFile, keys: await VaultKeys.derive(vaultKey, vaultId) };
}

export async function unlockWithPassword(kf: KeyFile, password: string): Promise<VaultKeys> {
  const salt = fromB64(kf.kdf.salt);
  const pk = await aesKey(
    await argon2Key(password, salt, {
      memoryKiB: kf.kdf.memoryKiB,
      iterations: kf.kdf.iterations,
      parallelism: kf.kdf.parallelism,
    }),
  );
  let vaultKey: Uint8Array;
  try {
    vaultKey = await gcmDecrypt(pk, fromB64(kf.wrappedKey), wrapAad(kf.vaultId));
  } catch (e) {
    if (e instanceof DecryptError) throw new WrongPasswordError();
    throw e;
  }
  return VaultKeys.derive(vaultKey, kf.vaultId);
}

/** Unlock with a raw vault key (remembered on this device, or a recovery key). */
export async function unlockWithRawKey(kf: KeyFile, vaultKey: Uint8Array): Promise<VaultKeys> {
  const check = await keyCheck(vaultKey, kf.vaultId);
  if (!bytesEqual(utf8(check), utf8(kf.keyCheck))) throw new WrongPasswordError("This key does not belong to this vault");
  return VaultKeys.derive(vaultKey, kf.vaultId);
}

export async function changePassword(
  kf: KeyFile,
  keys: VaultKeys,
  newPassword: string,
  params?: Argon2Params,
): Promise<KeyFile> {
  if (!newPassword) throw new KeyFileError("Password must not be empty");
  const p = params ?? { memoryKiB: kf.kdf.memoryKiB, iterations: kf.kdf.iterations, parallelism: kf.kdf.parallelism };
  const w = await wrap(keys.exportRaw(), kf.vaultId, newPassword, p);
  return { ...kf, kdf: { alg: "argon2id", salt: w.salt, ...p }, wrappedKey: w.wrappedKey };
}

// Recovery key: "EGR1-" followed by the vault key in base32, in groups of 4.
export function formatRecoveryKey(keys: VaultKeys): string {
  const s = toBase32(keys.exportRaw());
  return "EGR1-" + (s.match(/.{1,4}/g) ?? []).join("-");
}

export function parseRecoveryKey(text: string): Uint8Array {
  const t = text.trim().toUpperCase().replace(/[\s-]+/g, "");
  if (!t.startsWith("EGR1")) throw new WrongPasswordError("Not a recovery key (should start with EGR1-)");
  let raw: Uint8Array;
  try {
    raw = fromBase32(t.slice(4));
  } catch {
    throw new WrongPasswordError("Recovery key contains invalid characters");
  }
  if (raw.length !== 32) throw new WrongPasswordError("Recovery key is the wrong length");
  return raw;
}
