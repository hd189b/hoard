// Obsidian's own secret storage (Windows, Android, macOS). Secrets stay on this device.

import type { App } from "obsidian";
import type { SecretStore } from "../core/secrets";

/** Obsidian accepts lowercase letters, digits and dashes, at most 64 characters. */
export function obsidianSecretId(ns: string, key: string): string {
  const id = `encgidian-${ns}-${key}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (id.length > 64) throw new Error(`internal: secret id too long (${id.length} > 64): ${key}`);
  return id;
}

export class ObsidianSecretStore implements SecretStore {
  readonly kind = "obsidian";
  readonly label = "Obsidian secret storage";
  constructor(
    private readonly app: App,
    private readonly ns: string,
  ) {}

  private id(key: string) {
    return obsidianSecretId(this.ns, key);
  }

  private store() {
    const s = this.app.secretStorage;
    if (!s) throw new Error("This Obsidian version has no secret storage; update Obsidian to 1.11.4 or newer");
    return s;
  }

  async get(key: string) {
    const v = this.store().getSecret(this.id(key));
    return v === null || v === "" ? null : v;
  }
  async set(key: string, value: string) {
    this.store().setSecret(this.id(key), value);
  }
  async delete(key: string) {
    this.store().setSecret(this.id(key), "");
  }
}
