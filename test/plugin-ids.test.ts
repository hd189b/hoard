import { describe, expect, it } from "vitest";
import { obsidianSecretId } from "../src/plugin/secret-obsidian";
import { randomId, secretKeys } from "../src/plugin/settings";

describe("Obsidian secret ids", () => {
  it("every secret name fits Obsidian's rule (lowercase, digits, dashes, <= 64)", () => {
    const ns = randomId(8); // localId as created by the plugin
    const vaultId = "f".repeat(32);
    const remote = randomId();
    for (const key of [secretKeys.vaultKey(vaultId), secretKeys.remoteSecret(remote), secretKeys.sshPassphrase(remote)]) {
      const id = obsidianSecretId(ns, key);
      expect(id).toMatch(/^[a-z0-9-]{1,64}$/);
    }
  });
});
