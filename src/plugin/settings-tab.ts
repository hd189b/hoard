import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import { moveSecrets } from "../core/secrets";
import { isSshUrl } from "../core/transport";
import { githubDeviceLogin } from "./github";
import type EncgidianPlugin from "./main";
import { CopyTextModal, DeviceCodeModal, PasswordModal } from "./modals";
import { AuthMethod, Engine, newRemote, RemoteConfig, secretKeys } from "./settings";

const AUTH_LABEL: Record<AuthMethod, string> = {
  token: "Access token",
  github: "Sign in with GitHub",
  password: "Username and password",
  ssh: "SSH key (desktop only)",
  none: "None (public or local server)",
};

export class EncgidianSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: EncgidianPlugin,
  ) {
    super(app, plugin);
  }

  private save = async () => {
    await this.plugin.saveSettings();
  };

  display(): void {
    const { containerEl: el } = this;
    const p = this.plugin;
    const s = p.conf;
    el.empty();

    // ----- this device -----
    new Setting(el).setName("This device").setHeading();
    new Setting(el)
      .setName("Device name")
      .setDesc("Used in conflict copy names. Stored only inside the encrypted data.")
      .addText((t) =>
        t
          .setPlaceholder(p.deviceName())
          .setValue(s.deviceName)
          .onChange(async (v) => {
            s.deviceName = v.trim();
            await this.save();
          }),
      );

    this.passwordStorage(el);

    new Setting(el)
      .setName("Remember the vault key on this device")
      .setDesc("Off: you're asked for the password once each time Obsidian starts.")
      .addToggle((t) =>
        t.setValue(s.rememberPassword).onChange(async (v) => {
          s.rememberPassword = v;
          await this.save();
          if (!v && p.keys) await p.secrets.delete(secretKeys.vaultKey(p.keys.vaultId)).catch(() => {});
        }),
      );

    const pwSetting = new Setting(el)
      .setName("Vault password")
      .addButton((b) => b.setButtonText("Change password").onClick(() => p.changePassword().catch((e) => new Notice(e.message))))
      .addButton((b) => b.setButtonText("Show recovery key").onClick(() => p.showRecoveryKey().catch((e) => new Notice(e.message))))
      .addButton((b) => b.setButtonText("Lock now").onClick(() => p.lock()));
    // Three buttons don't fit on a phone in one row.
    pwSetting.controlEl.style.flexWrap = "wrap";
    pwSetting.controlEl.style.gap = "8px";

    // ----- hosts -----
    new Setting(el)
      .setName("Git hosts")
      .setDesc("Every sync goes to all enabled hosts. Each one holds a full encrypted copy with all history.")
      .setHeading()
      .addButton((b) =>
        b
          .setButtonText("Add host")
          .setCta()
          .onClick(async () => {
            s.remotes.push(newRemote());
            await this.save();
            this.display();
          }),
      );
    for (const r of s.remotes) this.remoteBlock(el, r);

    // ----- syncing -----
    new Setting(el).setName("Syncing").setHeading();
    new Setting(el)
      .setName("Sync every")
      .setDesc("Minutes between automatic syncs. 0 turns it off.")
      .addText((t) =>
        t.setValue(String(s.autoSyncMinutes)).onChange(async (v) => {
          s.autoSyncMinutes = Math.max(0, Number(v) || 0);
          await this.save();
          p.rescheduleAuto();
        }),
      );
    new Setting(el).setName("Sync when Obsidian starts").addToggle((t) =>
      t.setValue(s.syncOnStartup).onChange(async (v) => {
        s.syncOnStartup = v;
        await this.save();
      }),
    );
    new Setting(el)
      .setName("Sync after edits")
      .setDesc("Seconds after you stop editing. 0 turns it off.")
      .addText((t) =>
        t.setValue(String(s.syncAfterEditSeconds)).onChange(async (v) => {
          s.syncAfterEditSeconds = Math.max(0, Number(v) || 0);
          await this.save();
        }),
      );
    new Setting(el)
      .setName("Ignored folders")
      .setDesc("One per line. This device neither uploads nor downloads them, and never deletes them on the hosts.")
      .addTextArea((t) =>
        t.setValue(s.ignoredFolders.join("\n")).onChange(async (v) => {
          s.ignoredFolders = v
            .split("\n")
            .map((x) => x.trim().replace(/^\/+|\/+$/g, ""))
            .filter(Boolean);
          await this.save();
        }),
      );
    new Setting(el)
      .setName("Maximum file size (MB)")
      .setDesc(
        "Bigger files are left out on this device (they stay on the hosts). 0 means no limit." +
          (Platform.isMobile ? " On phones keep this at 10 MB or less: Obsidian for Android can crash on bigger downloads." : ""),
      )
      .addText((t) =>
        t.setValue(String(s.maxFileSizeMB)).onChange(async (v) => {
          s.maxFileSizeMB = Math.max(0, Number(v) || 0);
          await this.save();
        }),
      );
    new Setting(el)
      .setName(`Sync the ${this.app.vault.configDir} folder`)
      .setDesc("Settings, themes and plugins. Window layout and this plugin's own folder are never synced.")
      .addToggle((t) =>
        t.setValue(s.syncConfigDir).onChange(async (v) => {
          s.syncConfigDir = v;
          await this.save();
        }),
      );

    // ----- network (desktop) -----
    if (Platform.isDesktopApp) {
      new Setting(el).setName("Network").setHeading();
      new Setting(el)
        .setName("Proxy")
        .setDesc("http://host:port or socks5://host:port. Empty: no proxy. (On Android, use the phone's proxy or VPN.)")
        .addText((t) =>
          t
            .setPlaceholder("socks5://127.0.0.1:1080")
            .setValue(s.proxy)
            .onChange(async (v) => {
              s.proxy = v.trim();
              await this.save();
            }),
        );
      new Setting(el)
        .setName("Git program")
        .setDesc("Needed only for SSH hosts. Empty: use git from PATH.")
        .addText((t) =>
          t
            .setPlaceholder(Platform.isWin ? "C:\\Program Files\\Git\\cmd\\git.exe" : "/usr/bin/git")
            .setValue(s.gitPath)
            .onChange(async (v) => {
              s.gitPath = v.trim();
              await this.save();
            }),
        );
    }

    // ----- advanced -----
    new Setting(el).setName("Advanced").setHeading();
    new Setting(el)
      .setName("Password key strength")
      .setDesc("Applies when a vault is created or the password is changed. Strong uses 128 MB of memory; keep Standard if you use a phone.")
      .addDropdown((d) =>
        d
          .addOptions({ standard: "Standard (64 MB)", strong: "Strong (128 MB)" })
          .setValue(s.kdfStrength)
          .onChange(async (v) => {
            s.kdfStrength = v as "standard" | "strong";
            await this.save();
          }),
      );
    new Setting(el)
      .setName("GitHub OAuth app client ID")
      .setDesc("Needed for “Sign in with GitHub”. Create an OAuth app on GitHub with Device Flow enabled and paste its client ID.")
      .addText((t) =>
        t.setValue(s.githubClientId).onChange(async (v) => {
          s.githubClientId = v.trim();
          await this.save();
        }),
      );
  }

  private passwordStorage(el: HTMLElement) {
    const p = this.plugin;
    const d = p.desktop;
    if (!p.isLinux() || !d) {
      new Setting(el).setName("Password storage").setDesc(`${p.secrets.label}. Secrets stay on this device and are never synced.`);
      return;
    }
    const setting = new Setting(el).setName("Password storage").setDesc("Checking…");
    d.detectLinuxBackends().then((det) => {
      const cur = p.conf.linuxSecretBackend;
      const found = det.available.map((b) => d.LINUX_BACKEND_LABEL[b]).join(", ");
      setting.setDesc(
        `Checked in order: KeePassXC, KWallet, GNOME Keyring, plain text. Found: ${found}.` +
          (cur === "plaintext" ? " ⚠ Plain text: anyone who can read your home folder can read these secrets." : ""),
      );
      if (det.kwalletNeedsWallet) {
        setting.addButton((b) =>
          b.setButtonText("Create KWallet wallet").onClick(async () => {
            b.setDisabled(true);
            new Notice("KWallet will open a window to create the wallet. Follow it, then come back here.", 10000);
            try {
              if (await d.createKWallet()) new Notice("KWallet wallet is ready. You can now choose KWallet below.");
              else new Notice("The wallet wasn't created (cancelled?).");
            } catch (e) {
              new Notice((e as Error).message);
            }
            this.display();
          }),
        );
      }
      setting.addDropdown((dd) => {
        for (const b of d.LINUX_BACKEND_ORDER) {
          const ok = det.available.includes(b);
          dd.addOption(b, `${d.LINUX_BACKEND_LABEL[b]}${ok ? "" : " (not available)"}`);
        }
        dd.setValue(cur).onChange(async (v) => {
          if (!det.available.includes(v as never)) {
            new Notice(det.notes[v as keyof typeof det.notes] ?? "Not available");
            dd.setValue(cur);
            return;
          }
          const to = d.linuxStore(v as never, p.conf.localId);
          try {
            const n = await moveSecrets(p.secrets, to, p.allSecretKeys());
            p.secrets = to;
            p.conf.linuxSecretBackend = v;
            await this.save();
            new Notice(`Moved ${n} secret${n === 1 ? "" : "s"} to ${to.label}.`);
          } catch (e) {
            new Notice(`Couldn't switch: ${(e as Error).message}`);
          }
          this.display();
        });
      });
    });
  }

  private remoteBlock(el: HTMLElement, r: RemoteConfig) {
    const p = this.plugin;
    const box = el.createDiv({ cls: "encgidian-remote" });
    box.style.border = "1px solid var(--background-modifier-border)";
    box.style.borderRadius = "8px";
    box.style.padding = "0 12px";
    box.style.marginBottom = "12px";

    const fullWidth = (st: Setting) => {
      // On phones, put the control on its own full-width line under the label.
      if (!Platform.isMobile) return;
      st.settingEl.style.flexWrap = "wrap";
      st.controlEl.style.width = "100%";
      st.controlEl.style.flex = "1 1 100%";
      st.controlEl.querySelectorAll("input[type=text], textarea").forEach((i) => ((i as HTMLElement).style.flex = "1"));
    };
    const nameSetting = new Setting(box)
      .setName("Host name")
      .setDesc("Shown in notices and the status bar. The toggle turns this host on or off.")
      .addText((t) => {
        if (!Platform.isMobile) t.inputEl.style.width = "12em";
        t.setValue(r.name).onChange(async (v) => {
          r.name = v.trim() || "Host";
          await this.save();
        });
      })
      .addToggle((t) =>
        t
          .setTooltip("Enabled")
          .setValue(r.enabled)
          .onChange(async (v) => {
            r.enabled = v;
            await this.save();
          }),
      );
    fullWidth(nameSetting);

    const urlSetting = new Setting(box)
      .setName("Repository URL")
      .setDesc("https://… or git@host:user/repo.git. Several URLs (one per line) are all kept up to date. Use a new, empty, private repository.")
      .addTextArea((t) => {
        t.inputEl.rows = Math.max(1, r.urls.length);
        t.setPlaceholder("https://github.com/you/vault-backup.git")
          .setValue(r.urls.join("\n"))
          .onChange(async (v) => {
            r.urls = v.split("\n").map((x) => x.trim());
            await this.save();
          });
      });
    urlSetting.controlEl.querySelector("textarea")?.style.setProperty("width", "100%");
    fullWidth(urlSetting);

    new Setting(box).setName("Sign-in method").addDropdown((d) => {
      for (const [k, label] of Object.entries(AUTH_LABEL)) {
        if (k === "ssh" && !Platform.isDesktopApp) continue;
        d.addOption(k, label);
      }
      d.setValue(r.auth).onChange(async (v) => {
        r.auth = v as AuthMethod;
        await this.save();
        this.display();
      });
    });

    if (r.urls.some((u) => isSshUrl(u)) && r.auth !== "ssh") {
      box.createEl("p", { text: "⚠ This URL uses SSH; choose “SSH key” as the sign-in method.", cls: "mod-warning" });
    }

    const secretSetting = (name: string, desc: string, key: string) => {
      const st = new Setting(box).setName(name).setDesc(desc);
      // Block bodies on purpose: Obsidian's Setting has a then() method, so returning
      // it from a promise callback makes the promise chase it forever.
      p.secrets.get(key).then(
        (v) => {
          st.setDesc(`${desc} ${v ? "✓ Saved" : "Not set."}`);
        },
        (e) => {
          st.setDesc(`${desc} ⚠ ${e.message}`);
        },
      );
      st.addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("Paste and press Save");
        st.addButton((b) =>
          b.setButtonText("Save").onClick(async () => {
            try {
              if (t.getValue()) await p.secrets.set(key, t.getValue());
              else await p.secrets.delete(key);
              t.setValue("");
              new Notice(`Saved in ${p.secrets.label}.`);
              this.display();
            } catch (e) {
              new Notice(`Couldn't save: ${(e as Error).message}`);
            }
          }),
        );
      });
    };

    switch (r.auth) {
      case "token":
        new Setting(box)
          .setName("Username")
          .setDesc("Optional for GitHub and GitLab. For Codeberg/Gitea, your user name.")
          .addText((t) =>
            t.setValue(r.username).onChange(async (v) => {
              r.username = v.trim();
              await this.save();
            }),
          );
        secretSetting("Access token", "Needs read and write access to this repository only.", secretKeys.remoteSecret(r.id));
        break;
      case "password":
        new Setting(box).setName("Username").addText((t) =>
          t.setValue(r.username).onChange(async (v) => {
            r.username = v.trim();
            await this.save();
          }),
        );
        secretSetting("Password", "For servers that still accept passwords (GitHub and GitLab.com don't).", secretKeys.remoteSecret(r.id));
        break;
      case "github": {
        const st = new Setting(box).setName("GitHub account").setDesc("Checking…");
        p.secrets.get(secretKeys.remoteSecret(r.id)).then((v) => {
          st.setDesc(v ? "✓ Signed in" : "Not signed in");
        });
        st.addButton((b) =>
          b.setButtonText("Sign in with GitHub").onClick(async () => {
            let cancelled = false;
            let modal: DeviceCodeModal | null = null;
            try {
              const token = await githubDeviceLogin(
                p.conf.githubClientId,
                (code, uri) => {
                  modal = new DeviceCodeModal(this.app, code, uri, () => (cancelled = true));
                  modal.open();
                },
                () => cancelled,
              );
              await p.secrets.set(secretKeys.remoteSecret(r.id), token);
              r.username = "x-access-token";
              await this.save();
              new Notice("Signed in to GitHub.");
            } catch (e) {
              new Notice((e as Error).message);
            } finally {
              cancelled = true;
              (modal as DeviceCodeModal | null)?.close();
              this.display();
            }
          }),
        );
        break;
      }
      case "ssh":
        if (!p.desktop) break;
        new Setting(box)
          .setName("SSH private key")
          .setDesc("Path to the key file. Empty: your SSH agent and default keys.")
          .addText((t) =>
            t
              .setPlaceholder(Platform.isWin ? "C:\\Users\\you\\.ssh\\id_ed25519" : "~/.ssh/id_ed25519")
              .setValue(r.sshKeyPath)
              .onChange(async (v) => {
                r.sshKeyPath = v.trim().replace(/^~(?=\/|\\)/, (globalThis as { process?: { env: Record<string, string> } }).process?.env.HOME ?? "~");
                await this.save();
              }),
          )
          .addButton((b) =>
            b.setButtonText("Generate a key for this vault").onClick(async () => {
              const d = p.desktop!;
              const base = (this.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath();
              const file = d.joinPath(base, p.pluginDir, "ssh", `id_ed25519_${r.id}`);
              const pass = Array.from(crypto.getRandomValues(new Uint8Array(24)), (x) => x.toString(16).padStart(2, "0")).join("");
              try {
                const pub = await d.generateSshKey(d.joinPath(base, p.pluginDir, "ssh"), file, pass, `encgidian ${p.deviceName()}`);
                await p.secrets.set(secretKeys.sshPassphrase(r.id), pass);
                r.sshKeyPath = file;
                await this.save();
                new CopyTextModal(
                  this.app,
                  "New SSH key",
                  "Add this public key to the host. On GitHub: repository → Settings → Deploy keys → Add, and tick “Allow write access”. The private key stays in this plugin's folder, protected by a random passphrase kept in your password storage.",
                  pub,
                ).open();
                this.display();
              } catch (e) {
                new Notice((e as Error).message);
              }
            }),
          );
        secretSetting("Key passphrase", "Leave empty if the key has none (not recommended).", secretKeys.sshPassphrase(r.id));
        break;
    }

    if (Platform.isDesktopApp) {
      new Setting(box)
        .setName("Git engine")
        .setDesc("Auto: built-in for HTTPS, system Git for SSH.")
        .addDropdown((d) =>
          d
            .addOptions({ auto: "Auto", builtin: "Built-in", system: "System Git" })
            .setValue(r.engine)
            .onChange(async (v) => {
              r.engine = v as Engine;
              await this.save();
            }),
        );
    }

    const test = new Setting(box);
    const out = box.createEl("pre", { cls: "encgidian-test-result" });
    out.style.whiteSpace = "pre-wrap";
    out.style.display = "none";
    const replaceBox = box.createDiv();
    test
      .addButton((b) =>
        b.setButtonText("Test").onClick(async () => {
          b.setDisabled(true);
          out.style.display = "";
          out.setText("Testing…");
          replaceBox.empty();
          try {
            const res = await p.checkRemote(r);
            out.setText(res.lines.join("\n"));
            for (const ep of res.replaceable) {
              new Setting(replaceBox)
                .setName("Use this repository anyway?")
                .setDesc(`${ep.url} has other content. If it's only starter files (like a README), it can be replaced by this vault. You'll be asked to confirm.`)
                .addButton((rb) =>
                  rb
                    .setButtonText("Replace with this vault")
                    .setWarning()
                    .onClick(async () => {
                      rb.setDisabled(true);
                      try {
                        await p.replaceRemoteContent(ep);
                        out.setText(await p.testRemote(r));
                        replaceBox.empty();
                      } catch (e) {
                        new Notice((e as Error).message, 15000);
                      }
                      rb.setDisabled(false);
                    }),
                );
            }
          } catch (e) {
            out.setText(`✗ ${(e as Error).message}`);
          }
          b.setDisabled(false);
        }),
      )
      .addButton((b) =>
        b
          .setButtonText("Remove host")
          .setWarning()
          .onClick(async () => {
            p.conf.remotes = p.conf.remotes.filter((x) => x !== r);
            await p.secrets.delete(secretKeys.remoteSecret(r.id)).catch(() => {});
            await p.secrets.delete(secretKeys.sshPassphrase(r.id)).catch(() => {});
            await this.save();
            this.display();
          }),
      );
    void PasswordModal;
  }
}
