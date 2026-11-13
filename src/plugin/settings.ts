// Plugin settings. Stored in the plugin's data.json, which lives in the plugin
// folder and is never synced, so every setting here is per device.

export type AuthMethod = "none" | "token" | "password" | "github" | "ssh";
export type Engine = "auto" | "builtin" | "system";

export interface RemoteConfig {
  id: string;
  name: string;
  /** One or more URLs; each is fetched and pushed. */
  urls: string[];
  enabled: boolean;
  engine: Engine;
  auth: AuthMethod;
  username: string;
  sshKeyPath: string;
}

export interface Settings {
  /** Random id for this install; names its secrets. */
  localId: string;
  deviceName: string;
  remotes: RemoteConfig[];
  autoSyncMinutes: number;
  syncOnStartup: boolean;
  syncAfterEditSeconds: number;
  proxy: string;
  gitPath: string;
  ignoredFolders: string[];
  maxFileSizeMB: number;
  syncConfigDir: boolean;
  rememberPassword: boolean;
  kdfStrength: "standard" | "strong";
  githubClientId: string;
  /** Linux only: chosen secret backend, "" = not chosen yet. */
  linuxSecretBackend: string;
}

export const DEFAULT_SETTINGS: Settings = {
  localId: "",
  deviceName: "",
  remotes: [],
  autoSyncMinutes: 10,
  syncOnStartup: true,
  syncAfterEditSeconds: 30,
  proxy: "",
  gitPath: "",
  ignoredFolders: [],
  maxFileSizeMB: 50,
  syncConfigDir: false,
  rememberPassword: true,
  kdfStrength: "standard",
  githubClientId: "",
  linuxSecretBackend: "",
};

export const KDF = {
  standard: { memoryKiB: 65536, iterations: 3, parallelism: 1 },
  strong: { memoryKiB: 131072, iterations: 4, parallelism: 1 },
};

export const randomId = (bytes = 4) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");

export function newRemote(): RemoteConfig {
  return { id: randomId(), name: "New host", urls: [""], enabled: true, engine: "auto", auth: "token", username: "", sshKeyPath: "" };
}

export const secretKeys = {
  vaultKey: (vaultId: string) => `vault-key-${vaultId}`,
  remoteSecret: (remoteId: string) => `remote-${remoteId}-secret`,
  sshPassphrase: (remoteId: string) => `remote-${remoteId}-sshpass`,
};
