// Which vault files take part in syncing on this device.

export interface FilterOptions {
  /** Obsidian config folder name, usually ".obsidian". */
  configDir: string;
  /** This plugin's folder inside the config folder (never synced). */
  pluginDir: string;
  syncConfigDir: boolean;
  ignoredFolders: string[];
  /** Bytes; 0 means no limit. */
  maxFileSize: number;
}

const under = (path: string, folder: string) => {
  const f = folder.replace(/^\/+|\/+$/g, "");
  return f !== "" && (path === f || path.startsWith(f + "/"));
};

/** Files in the config folder that differ per device and change all the time. */
const PER_DEVICE_CONFIG = /^(workspace(-mobile)?\.json|workspaces\.json|cache|graph\.json)$/;

export function isExcluded(path: string, size: number, o: FilterOptions): boolean {
  if (under(path, o.pluginDir)) return true;
  if (path === ".git" || path.startsWith(".git/") || path.startsWith(".trash/")) return true;
  if (under(path, o.configDir)) {
    if (!o.syncConfigDir) return true;
    if (PER_DEVICE_CONFIG.test(path.slice(o.configDir.length + 1))) return true;
  }
  if (o.ignoredFolders.some((f) => under(path, f))) return true;
  if (o.maxFileSize > 0 && size > o.maxFileSize) return true;
  return false;
}
