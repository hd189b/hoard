import { Notice, Platform, Plugin, TFile, debounce } from "obsidian";
import { fromB64, toB64 } from "../core/bytes";
import { fileVersions, deletedFiles, Version } from "../core/history";
import { createKeyFile, formatRecoveryKey, KeyFile, unlockWithPassword, unlockWithRawKey, VaultKeys, WrongPasswordError } from "../core/keys";
import { clashKey, splitPath, uniqueName } from "../core/names";
import { Repo, GitFs } from "../core/repo";
import { SecretStore } from "../core/secrets";
import { RemoteStatus, SyncEngine, SyncReport } from "../core/sync";
import { Endpoint, IsoTransport, isSshUrl, Transport, Credentials } from "../core/transport";
import { contentHash } from "../core/format";
import { adapterFs } from "./adapter-fs";
import { obsidianHttp } from "./http-obsidian";
import { ConfirmModal, CopyTextModal, DeletedPickModal, fmtTime, PasswordModal, VersionPickModal, VersionPreviewModal } from "./modals";
import { AdapterState, ObsidianVault } from "./obsidian-vault";
import { ObsidianSecretStore } from "./secret-obsidian";
import { DEFAULT_SETTINGS, KDF, randomId, RemoteConfig, secretKeys, Settings } from "./settings";
import { EncgidianSettingTab } from "./settings-tab";

type Desktop = typeof import("../platform/desktop");

export class LockedError extends Error {
  constructor() {
    super("The vault is locked. Run “Sync now” to unlock it.");
    this.name = "LockedError";
  }
}

class CancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "CancelledError";
  }
}

const RETRY_MINUTES = [1, 2, 5, 10];

export default class EncgidianPlugin extends Plugin {
  conf!: Settings;
  secrets!: SecretStore;
  desktop: Desktop | null = null;
  repo!: Repo;
  engine!: SyncEngine;
  vaultIO!: ObsidianVault;
  keys: VaultKeys | null = null;
  lastReport: SyncReport | null = null;
  lastError: string | null = null;
  lastSyncAt = 0;
  progressText: string | null = null;
  private interactive = false;
  private statusEl!: HTMLElement;
  private autoTimer: number | null = null;
  private retryTimer: number | null = null;
  private retryStep = 0;
  private dirtyDuringSync = false;
  private shownErrors = new Map<string, string>();
  private transports = new Map<string, Transport>();
  private editSync = debounce(() => this.syncNow(false), 30_000, true);

  get pluginDir(): string {
    return this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
  }

  async onload() {
    await this.loadSettings();
    if (Platform.isDesktopApp) this.desktop = await import("../platform/desktop");
    this.secrets = await this.makeSecretStore();

    const gitdir = `${this.pluginDir}/repo`;
    let fs: GitFs;
    let repoPath = gitdir;
    if (this.desktop) {
      const base = (this.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath();
      repoPath = this.desktop.joinPath(base, gitdir);
      fs = this.desktop.nodeFs;
    } else {
      fs = adapterFs(this.app.vault.adapter);
    }
    this.repo = new Repo(fs, repoPath);
    this.vaultIO = new ObsidianVault(this.app);

    this.engine = new SyncEngine({
      repo: this.repo,
      vault: this.vaultIO,
      state: new AdapterState(this.app, `${this.pluginDir}/state.json`),
      keys: { unlock: (kf) => this.unlock(kf), create: () => this.createVault() },
      onProgress: (text) => {
        this.progressText = text;
        this.renderStatus();
      },
      transportFor: (ep) => this.transportFor(ep),
      endpoints: () => this.endpoints(),
      options: () => ({
        device: this.deviceName(),
        configDir: this.app.vault.configDir,
        pluginDir: this.pluginDir,
        syncConfigDir: this.conf.syncConfigDir,
        ignoredFolders: this.conf.ignoredFolders,
        maxFileSize: Math.round(this.conf.maxFileSizeMB * 1024 * 1024),
      }),
    });

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("mod-clickable");
    this.statusEl.addEventListener("click", () => this.syncNow(true));
    this.addRibbonIcon("refresh-cw", "Encrypted sync: sync now", () => this.syncNow(true));
    this.renderStatus();

    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => this.syncNow(true) });
    this.addCommand({
      id: "restore-version",
      name: "Restore older version of this note",
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f) return false;
        if (!checking) this.restoreVersion(f).catch((e) => this.fail(e));
        return true;
      },
    });
    this.addCommand({ id: "restore-deleted", name: "Restore deleted file", callback: () => this.restoreDeleted().catch((e) => this.fail(e)) });
    this.addCommand({ id: "change-password", name: "Change vault password", callback: () => this.changePassword().catch((e) => this.fail(e)) });
    this.addCommand({ id: "show-recovery-key", name: "Show recovery key", callback: () => this.showRecoveryKey().catch((e) => this.fail(e)) });
    this.addCommand({ id: "lock-vault", name: "Lock vault (ask for the password next time)", callback: () => this.lock() });
    this.addCommand({ id: "show-status", name: "Show sync status of each host", callback: () => this.showStatus() });

    this.addSettingTab(new EncgidianSettingTab(this.app, this));

    for (const ev of ["modify", "create", "delete", "rename"] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.registerEvent(this.app.vault.on(ev as any, (f: { path: string }) => this.onVaultChange(f.path)));
    }

    this.app.workspace.onLayoutReady(() => {
      this.rescheduleAuto();
      if (this.conf.syncOnStartup && this.conf.remotes.some((r) => r.enabled)) {
        window.setTimeout(() => this.syncNow(false), 3000);
      }
    });
  }

  onunload() {
    this.keys?.wipe();
    this.keys = null;
    if (this.autoTimer) window.clearInterval(this.autoTimer);
    if (this.retryTimer) window.clearTimeout(this.retryTimer);
  }

  // ---------- settings & secrets ----------

  async loadSettings() {
    const saved = (await this.loadData()) ?? {};
    this.conf = Object.assign({}, DEFAULT_SETTINGS, saved);
    // Obsidian for Android crashes on downloads much above ~20 MB, so phones skip big files by default.
    if (Platform.isMobile && saved.maxFileSizeMB === undefined) this.conf.maxFileSizeMB = 10;
    if (!this.conf.localId) {
      this.conf.localId = randomId(8);
      await this.saveSettings();
    }
  }

  async saveSettings() {
    await this.saveData(this.conf);
    this.transports.clear();
  }

  deviceName(): string {
    return (this.conf.deviceName || (Platform.isMobile ? "Phone" : Platform.isLinux ? "Linux" : Platform.isWin ? "Windows" : "Desktop")).trim();
  }

  isLinux(): boolean {
    return !!this.desktop && this.desktop.platform() === "linux";
  }

  async makeSecretStore(): Promise<SecretStore> {
    if (this.isLinux() && this.desktop) {
      let kind = this.conf.linuxSecretBackend;
      if (!kind) {
        kind = this.desktop.pickDefault(await this.desktop.detectLinuxBackends());
        this.conf.linuxSecretBackend = kind;
        await this.saveSettings();
        if (kind === "plaintext") {
          new Notice("Encrypted sync: no keyring found (KeePassXC, KWallet or GNOME Keyring). Passwords are stored in a plain file only you can read. You can change this in settings.", 15000);
        }
      }
      return this.desktop.linuxStore(kind as never, this.conf.localId);
    }
    return new ObsidianSecretStore(this.app, this.conf.localId);
  }

  /** Every secret key this install may have stored. */
  allSecretKeys(): string[] {
    const keys = this.conf.remotes.flatMap((r) => [secretKeys.remoteSecret(r.id), secretKeys.sshPassphrase(r.id)]);
    if (this.keys) keys.push(secretKeys.vaultKey(this.keys.vaultId));
    return keys;
  }

  // ---------- keys ----------

  private async unlock(kf: KeyFile): Promise<VaultKeys> {
    if (this.keys?.vaultId === kf.vaultId) return this.keys;
    const stored = await this.secrets.get(secretKeys.vaultKey(kf.vaultId)).catch(() => null);
    if (stored) {
      try {
        this.keys = await unlockWithRawKey(kf, fromB64(stored));
        return this.keys;
      } catch {
        /* stale; ask */
      }
    }
    if (!this.interactive) throw new LockedError();
    for (let hint = "Enter the vault password."; ; hint = "Wrong password, try again.") {
      const pw = await PasswordModal.ask(this.app, "Unlock encrypted vault", { hint });
      if (pw === null) throw new CancelledError();
      try {
        this.keys = await unlockWithPassword(kf, pw);
        break;
      } catch (e) {
        if (!(e instanceof WrongPasswordError)) throw e;
      }
    }
    await this.rememberKey();
    return this.keys;
  }

  private async rememberKey() {
    if (!this.keys) return;
    if (this.conf.rememberPassword) {
      await this.secrets.set(secretKeys.vaultKey(this.keys.vaultId), toB64(this.keys.exportRaw())).catch((e) => {
        new Notice(`Encrypted sync: couldn't save the key in ${this.secrets.label}: ${e.message}`);
      });
    }
  }

  private async createVault() {
    if (!this.interactive) throw new LockedError();
    const ok = await ConfirmModal.ask(
      this.app,
      "Set up a new encrypted vault",
      "The Git hosts are empty, so a new encrypted vault will be created there. Choose a password. " +
        "If you forget it, the backups can't be read; you'll be shown a recovery key to keep somewhere safe.",
      "Continue",
    );
    if (!ok) throw new CancelledError();
    const pw = await PasswordModal.ask(this.app, "New vault password", { confirm: true });
    if (pw === null) throw new CancelledError();
    const r = await createKeyFile(pw, KDF[this.conf.kdfStrength]);
    this.keys = r.keys;
    await this.rememberKey();
    new CopyTextModal(
      this.app,
      "Recovery key",
      "Write this down or store it in a password manager. It opens the vault if you forget the password. Anyone with it can read your notes.",
      formatRecoveryKey(r.keys),
    ).open();
    return r;
  }

  /** Keys for the local repo's vault, asking for the password if needed. */
  async ensureKeys(): Promise<{ keys: VaultKeys; head: string }> {
    const head = await this.repo.head();
    const id = head ? await this.repo.keyFileAt(head) : null;
    if (!head || !id) throw new Error("Nothing synced on this device yet. Run “Sync now” first.");
    this.interactive = true;
    try {
      return { keys: await this.unlock(id.keyFile), head };
    } finally {
      this.interactive = false;
    }
  }

  lock() {
    const id = this.keys?.vaultId;
    this.keys?.wipe();
    this.keys = null;
    if (id) this.secrets.delete(secretKeys.vaultKey(id)).catch(() => {});
    new Notice("Encrypted sync: vault locked. The password will be asked at the next sync.");
    this.renderStatus();
  }

  // ---------- hosts ----------

  endpoints(): Endpoint[] {
    const out: Endpoint[] = [];
    for (const r of this.conf.remotes) {
      if (!r.enabled) continue;
      r.urls
        .map((u) => u.trim())
        .filter(Boolean)
        .forEach((url, i) => {
          out.push({
            id: `${r.id}-${i}`,
            name: r.urls.filter((u) => u.trim()).length > 1 ? `${r.name} (${i + 1})` : r.name,
            url,
            getCredentials: () => this.credentials(r),
          });
        });
    }
    return out;
  }

  async credentials(r: RemoteConfig): Promise<Credentials | undefined> {
    const secret = async (k: string) => (await this.secrets.get(k)) ?? undefined;
    switch (r.auth) {
      case "token":
      case "password":
      case "github":
        return { username: r.username || undefined, password: await secret(secretKeys.remoteSecret(r.id)) };
      case "ssh":
        return { sshKeyPath: r.sshKeyPath || undefined, sshPassphrase: await secret(secretKeys.sshPassphrase(r.id)) };
      default:
        return undefined;
    }
  }

  transportFor(ep: Endpoint): Transport {
    const remote = this.conf.remotes.find((r) => ep.id.startsWith(r.id + "-"));
    const useCli = isSshUrl(ep.url) || remote?.engine === "system";
    const key = useCli ? "cli" : "iso";
    let t = this.transports.get(key);
    if (t) return t;
    if (useCli) {
      if (!this.desktop) {
        throw new Error(isSshUrl(ep.url) ? "SSH hosts can't be used on Android; add an HTTPS URL for this host" : "System Git isn't available on Android");
      }
      const base = (this.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath();
      t = new this.desktop.CliTransport(this.repo, {
        gitPath: this.conf.gitPath || undefined,
        proxy: this.conf.proxy || undefined,
        helperDir: this.desktop.joinPath(base, this.pluginDir, "ssh"),
      });
    } else {
      t = new IsoTransport(this.repo, this.desktop ? this.desktop.makeNodeHttp({ proxy: this.conf.proxy || undefined }) : obsidianHttp);
    }
    this.transports.set(key, t);
    return t;
  }

  /** Check one host: reachable, signed in, and what it holds. */
  async testRemote(r: RemoteConfig): Promise<string> {
    return (await this.checkRemote(r)).lines.join("\n");
  }

  /** Like testRemote, plus the URLs that hold unrelated content and could be replaced. */
  async checkRemote(r: RemoteConfig): Promise<{ lines: string[]; replaceable: Endpoint[] }> {
    const lines: string[] = [];
    const replaceable: Endpoint[] = [];
    await this.repo.init();
    const urls = r.urls.map((u) => u.trim()).filter(Boolean);
    if (!urls.length) return { lines: ["Add a URL first."], replaceable };
    for (const [i, url] of urls.entries()) {
      const ep: Endpoint = { id: `${r.id}-${i}`, name: r.name, url, getCredentials: () => this.credentials(r) };
      try {
        const head = await this.transportFor(ep).fetch(ep);
        if (!head) {
          lines.push(`✓ ${url}: connected; the repository is empty and will be set up on the first sync.`);
          continue;
        }
        const kf = await this.repo.keyFileAt(head).catch(() => null);
        const localHead = await this.repo.head();
        const local = localHead ? await this.repo.keyFileAt(localHead) : null;
        if (!kf) {
          lines.push(`✗ ${url}: connected, but it holds other content, not an encrypted vault.`);
          replaceable.push(ep);
        } else if (local && local.keyFile.vaultId !== kf.keyFile.vaultId) lines.push(`✗ ${url}: connected, but it holds a different vault.`);
        else lines.push(`✓ ${url}: connected; holds this encrypted vault.`);
      } catch (e) {
        lines.push(`✗ ${url}: ${(e as Error).message}`);
      }
    }
    return { lines, replaceable };
  }

  /** After confirmation, overwrite a host's unrelated content with this vault. */
  async replaceRemoteContent(ep: Endpoint): Promise<void> {
    const info = await this.engine.inspectForReplace(ep);
    const ok = await ConfirmModal.ask(
      this.app,
      `Replace the content of ${ep.name}?`,
      `${ep.url} holds ${info.commits} commit${info.commits === 1 ? "" : "s"} of other content (for example a README the host created). ` +
        `It will be replaced by this encrypted vault, and that content will no longer be on its main branch. ` +
        `If the host protects its main branch, allow force-push there first.`,
      "Replace",
    );
    if (!ok) return;
    this.interactive = true;
    try {
      this.lastReport = await this.engine.replaceHost(ep, info.head);
      this.lastSyncAt = Date.now();
      this.report(this.lastReport, true);
    } finally {
      this.interactive = false;
      this.renderStatus();
    }
  }

  // ---------- syncing ----------

  private onVaultChange(path: string) {
    if (path.startsWith(this.pluginDir + "/") || path === this.pluginDir) return;
    const t = this.vaultIO.selfWrites.get(path);
    if (t && Date.now() - t < 5000) return;
    if (this.engine.isRunning) {
      this.dirtyDuringSync = true;
      return;
    }
    this.scheduleEditSync();
  }

  private scheduleEditSync() {
    const s = this.conf.syncAfterEditSeconds;
    if (!s || s <= 0 || !this.conf.remotes.some((r) => r.enabled)) return;
    this.editSync = debounce(() => this.syncNow(false), s * 1000, true);
    this.editSync();
  }

  rescheduleAuto() {
    if (this.autoTimer) window.clearInterval(this.autoTimer);
    this.autoTimer = null;
    const m = this.conf.autoSyncMinutes;
    if (m > 0) this.autoTimer = this.registerInterval(window.setInterval(() => this.syncNow(false), m * 60_000));
  }

  async syncNow(interactive: boolean): Promise<SyncReport | null> {
    if (!this.conf.remotes.some((r) => r.enabled && r.urls.some((u) => u.trim()))) {
      if (interactive) new Notice("Encrypted sync: add a Git host in the settings first.");
      return null;
    }
    if (this.engine.isRunning) {
      if (interactive) new Notice("Encrypted sync: already syncing…");
      return null;
    }
    this.interactive = interactive;
    this.dirtyDuringSync = false;
    const p = this.engine.sync();
    this.renderStatus();
    try {
      const r = await p;
      this.lastReport = r;
      this.lastError = null;
      this.lastSyncAt = Date.now();
      this.report(r, interactive);
      return r;
    } catch (e) {
      if (e instanceof LockedError) {
        this.lastError = "locked";
      } else if (!(e instanceof CancelledError)) {
        this.lastError = (e as Error).message;
        this.fail(e);
      }
      return null;
    } finally {
      this.interactive = false;
      this.renderStatus();
      this.scheduleRetry();
      if (this.dirtyDuringSync) this.scheduleEditSync();
    }
  }

  private report(r: SyncReport, interactive: boolean) {
    for (const c of [...r.conflicts, ...r.lateConflicts]) {
      new Notice(`Encrypted sync: “${c.path}” was changed on two devices. The other version was kept; yours is saved as “${c.copy}”.`, 0);
    }
    for (const c of r.clashes) new Notice(`Encrypted sync: “${c.from}” clashed with a file that differs only in capital letters; it is now “${c.to}”.`, 15000);
    if (r.missingLarge.length) {
      new Notice(`Encrypted sync: ${r.missingLarge.length} large file${r.missingLarge.length === 1 ? " isn't" : "s aren't"} on any reachable host yet and will be fetched later: ${r.missingLarge.slice(0, 3).join(", ")}`, 15000);
    }
    if (r.repoRepaired) {
      new Notice("Encrypted sync: this device's local copy of the history was damaged and has been rebuilt from a host. Your notes were not affected.", 20000);
    }
    if (r.repaired.length) {
      new Notice(`Encrypted sync: ${r.repaired.length} file${r.repaired.length === 1 ? " was" : "s were"} damaged on this device and restored from the encrypted copy: ${r.repaired.slice(0, 5).join(", ")}${r.repaired.length > 5 ? "…" : ""}`, 20000);
    }
    for (const c of r.renamedLocal) new Notice(`Encrypted sync: renamed “${c.from}” to “${c.to}” so it also works on Windows and Android.`, 15000);
    for (const st of r.remotes) {
      const prev = this.shownErrors.get(st.id);
      if (st.error && (prev !== st.error || interactive)) {
        new Notice(`Encrypted sync — ${st.name}: ${st.error}`, 15000);
        this.shownErrors.set(st.id, st.error);
      } else if (!st.error && prev) {
        new Notice(`Encrypted sync — ${st.name} is reachable again and up to date.`);
        this.shownErrors.delete(st.id);
      }
    }
    if (interactive && r.remotes.every((s) => !s.error)) {
      new Notice(`Encrypted sync: done${r.applied ? `, ${r.applied} file${r.applied === 1 ? "" : "s"} updated` : ""}.`);
    }
  }

  private scheduleRetry() {
    if (this.retryTimer) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const failing = this.lastReport?.remotes.some((s) => s.problem === "network" || s.problem === "rejected") || (this.lastError && this.lastError !== "locked");
    if (!failing) {
      this.retryStep = 0;
      return;
    }
    const mins = RETRY_MINUTES[Math.min(this.retryStep++, RETRY_MINUTES.length - 1)];
    this.retryTimer = window.setTimeout(() => this.syncNow(false), mins * 60_000);
  }

  private fail(e: unknown) {
    if (e instanceof CancelledError) return;
    new Notice(`Encrypted sync: ${(e as Error).message ?? e}`, 15000);
    console.error("[encgidian]", e);
  }

  renderStatus() {
    if (!this.statusEl) return;
    const r = this.lastReport;
    let text: string;
    if (this.progressText) text = `⟳ ${this.progressText}`;
    else if (this.engine?.isRunning) text = "⟳ Syncing…";
    else if (this.lastError === "locked") text = "🔒 Locked";
    else if (this.lastError) text = "⚠ Sync failed";
    else if (!r) text = "Encrypted sync";
    else {
      const bad = r.remotes.filter((s) => s.error).length;
      const t = new Date(this.lastSyncAt || Date.now());
      const hm = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
      text = bad ? `⚠ ${hm} · ${bad} host${bad > 1 ? "s" : ""} failing` : `✓ ${hm}`;
    }
    this.statusEl.setText(text);
    this.statusEl.setAttr("aria-label", this.statusLines().join("\n") + "\nClick to sync now");
    this.statusEl.setAttr("data-tooltip-position", "top");
  }

  statusLines(): string[] {
    const r = this.lastReport;
    if (this.lastError && this.lastError !== "locked") return [`Last sync failed: ${this.lastError}`];
    if (!r) return ["Not synced yet in this session"];
    return r.remotes.map((s: RemoteStatus) => `${s.upToDate ? "✓" : "⚠"} ${s.name}: ${s.error ?? (s.upToDate ? "up to date" : "behind")}`);
  }

  showStatus() {
    new Notice(this.statusLines().join("\n"), 15000);
  }

  // ---------- restore ----------

  async restoreVersion(file: TFile) {
    const { keys, head } = await this.ensureKeys();
    const versions: Version[] = await fileVersions(this.repo, keys, head, file.path);
    if (!versions.length) return void new Notice("No synced versions of this note yet.");
    const current = await contentHash(keys, new Uint8Array(await this.app.vault.readBinary(file)));
    new VersionPickModal(this.app, versions, current, async (v) => {
      const data = await this.engine.readEntry(keys, v.entry);
      new VersionPreviewModal(
        this.app,
        file.path,
        v,
        data,
        async () => {
          await this.app.vault.modifyBinary(file, data.slice().buffer);
          new Notice(`Restored the version from ${fmtTime(v.time)}. It will be synced as a new change.`);
        },
        async () => {
          const { dir, stem, ext } = splitPath(file.path);
          const taken = new Set(this.app.vault.getFiles().map((f) => clashKey(f.path)));
          const p = uniqueName(`${dir}${stem} (version ${fmtTime(v.time).replace(":", "")})${ext}`, taken);
          const f = await this.app.vault.createBinary(p, data.slice().buffer);
          await this.app.workspace.getLeaf(true).openFile(f);
        },
      ).open();
    }).open();
  }

  async restoreDeleted() {
    const { keys, head } = await this.ensureKeys();
    new Notice("Looking through the history…");
    const files = await deletedFiles(this.repo, keys, head);
    if (!files.length) return void new Notice("No deleted files in the history.");
    new DeletedPickModal(this.app, files, async (f) => {
      const data = await this.engine.readEntry(keys, f.last.entry);
      const taken = new Set(this.app.vault.getFiles().map((x) => clashKey(x.path)));
      const p = uniqueName(f.path, taken);
      await this.vaultIO.write(p, data, 0);
      new Notice(`Restored “${p}”.`);
      const tf = this.app.vault.getAbstractFileByPath(p);
      if (tf instanceof TFile) await this.app.workspace.getLeaf(true).openFile(tf);
    }).open();
  }

  // ---------- password & recovery ----------

  async changePassword() {
    const { keys } = await this.ensureKeys();
    void keys;
    const pw = await PasswordModal.ask(this.app, "New vault password", {
      confirm: true,
      hint: "Your notes are not re-encrypted; only the key that protects them changes. Note: old copies in the history still open with the old password.",
    });
    if (pw === null) return;
    this.interactive = true;
    try {
      const r = await this.engine.changePassword(pw, KDF[this.conf.kdfStrength]);
      this.lastReport = r;
      new Notice("Encrypted sync: password changed on every reachable host.");
    } finally {
      this.interactive = false;
      this.renderStatus();
    }
  }

  async showRecoveryKey() {
    const { keys } = await this.ensureKeys();
    new CopyTextModal(
      this.app,
      "Recovery key",
      "This key opens the vault even if you forget the password, here and in the standalone decrypter. Anyone with it can read your notes.",
      formatRecoveryKey(keys),
    ).open();
  }
}
