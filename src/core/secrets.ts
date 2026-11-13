// Where this device keeps passwords, tokens and the remembered vault key.

export interface SecretStore {
  /** Short id, e.g. "obsidian", "keepassxc", "plaintext". */
  readonly kind: string;
  /** Name shown in settings. */
  readonly label: string;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Copy all known keys from one store to another, then remove them from the old one. */
export async function moveSecrets(from: SecretStore, to: SecretStore, keys: string[]): Promise<number> {
  let n = 0;
  for (const k of keys) {
    const v = await from.get(k);
    if (v === null || v === "") continue;
    await to.set(k, v);
    if ((await to.get(k)) !== v) throw new Error(`Could not verify "${k}" in ${to.label}; nothing was removed from ${from.label}`);
    n++;
  }
  for (const k of keys) await from.delete(k).catch(() => {});
  return n;
}
