// Cryptographic primitives: WebCrypto (AES-256-GCM, HKDF-SHA256, HMAC-SHA256)
// and Argon2id from hash-wasm. All available on desktop and Android.

import { argon2id } from "hash-wasm";
import { buf, concat, utf8 } from "./bytes";

const subtle = (): SubtleCrypto => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("WebCrypto is not available on this platform");
  return s;
};

export class DecryptError extends Error {
  constructor(msg = "Decryption failed") {
    super(msg);
    this.name = "DecryptError";
  }
}

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

export interface Argon2Params {
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}

export const DEFAULT_ARGON2: Argon2Params = { memoryKiB: 65536, iterations: 3, parallelism: 1 };

export async function argon2Key(password: string, salt: Uint8Array, p: Argon2Params): Promise<Uint8Array> {
  if (salt.length < 16) throw new Error("salt too short");
  return argon2id({
    password: utf8(password.normalize("NFC")),
    salt,
    parallelism: p.parallelism,
    iterations: p.iterations,
    memorySize: p.memoryKiB,
    hashLength: 32,
    outputType: "binary",
  });
}

export async function hkdf(ikm: Uint8Array, info: string, salt: Uint8Array = new Uint8Array(32)): Promise<Uint8Array> {
  const base = await subtle().importKey("raw", buf(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await subtle().deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: buf(salt), info: buf(utf8(info)) },
    base,
    256,
  );
  return new Uint8Array(bits);
}

export async function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 32) throw new Error("AES key must be 32 bytes");
  return subtle().importKey("raw", buf(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function hmacKey(raw: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey("raw", buf(raw), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export async function hmac(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().sign("HMAC", key, buf(data)));
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest("SHA-256", buf(data)));
}

const IV_LEN = 12;

/** Returns iv || ciphertext || tag. */
export async function gcmEncrypt(key: CryptoKey, plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  const iv = randomBytes(IV_LEN);
  const ct = await subtle().encrypt(
    { name: "AES-GCM", iv: buf(iv), additionalData: buf(aad), tagLength: 128 },
    key,
    buf(plaintext),
  );
  return concat(iv, new Uint8Array(ct));
}

export async function gcmDecrypt(key: CryptoKey, data: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  if (data.length < IV_LEN + 16) throw new DecryptError("Encrypted data is truncated");
  try {
    const pt = await subtle().decrypt(
      { name: "AES-GCM", iv: buf(data.subarray(0, IV_LEN)), additionalData: buf(aad), tagLength: 128 },
      key,
      buf(data.subarray(IV_LEN)),
    );
    return new Uint8Array(pt);
  } catch {
    throw new DecryptError();
  }
}
