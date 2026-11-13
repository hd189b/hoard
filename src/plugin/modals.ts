import { App, ButtonComponent, FuzzySuggestModal, Modal, Setting, SuggestModal, TextComponent } from "obsidian";
import type { DeletedFile, Version } from "../core/history";

/** Ask for the vault password. Resolves to null when cancelled. */
export class PasswordModal extends Modal {
  private result: string | null = null;
  private done!: (v: string | null) => void;

  constructor(
    app: App,
    private readonly titleText: string,
    private readonly confirm: boolean,
    private readonly hint = "",
  ) {
    super(app);
  }

  static ask(app: App, title: string, opts: { confirm?: boolean; hint?: string } = {}): Promise<string | null> {
    const m = new PasswordModal(app, title, !!opts.confirm, opts.hint);
    return new Promise((r) => {
      m.done = r;
      m.open();
    });
  }

  onOpen() {
    const { contentEl } = this;
    this.setTitle(this.titleText);
    if (this.hint) contentEl.createEl("p", { text: this.hint });
    let a = "";
    let b = "";
    const err = contentEl.createEl("p", { cls: "mod-warning" });
    const submit = () => {
      if (!a) return err.setText("Enter a password.");
      if (this.confirm && a !== b) return err.setText("The passwords don't match.");
      if (this.confirm && a.length < 10) return err.setText("Use at least 10 characters. A few random words work well.");
      this.result = a;
      this.close();
    };
    const field = (name: string, set: (v: string) => void) =>
      new Setting(contentEl).setName(name).addText((t: TextComponent) => {
        t.inputEl.type = "password";
        t.inputEl.autocomplete = "off";
        t.onChange(set);
        t.inputEl.addEventListener("keydown", (e) => e.key === "Enter" && submit());
        return t;
      });
    field("Password", (v) => (a = v));
    if (this.confirm) field("Repeat password", (v) => (b = v));
    new Setting(contentEl)
      .addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((btn) => btn.setButtonText("OK").setCta().onClick(submit));
    window.setTimeout(() => contentEl.querySelector("input")?.focus(), 50);
  }

  onClose() {
    this.contentEl.empty();
    this.done(this.result);
  }
}

/** Show a block of text the user should copy (recovery key, SSH public key). */
export class CopyTextModal extends Modal {
  constructor(
    app: App,
    private readonly titleText: string,
    private readonly intro: string,
    private readonly text: string,
  ) {
    super(app);
  }
  onOpen() {
    this.setTitle(this.titleText);
    this.contentEl.createEl("p", { text: this.intro });
    const pre = this.contentEl.createEl("pre", { cls: "encgidian-copy" });
    pre.setText(this.text);
    pre.style.userSelect = "all";
    pre.style.whiteSpace = "pre-wrap";
    pre.style.wordBreak = "break-all";
    new Setting(this.contentEl)
      .addButton((b) =>
        b.setButtonText("Copy").onClick(async () => {
          await navigator.clipboard.writeText(this.text);
          b.setButtonText("Copied");
        }),
      )
      .addButton((b) => b.setButtonText("Close").setCta().onClick(() => this.close()));
  }
  onClose() {
    this.contentEl.empty();
  }
}

export class ConfirmModal extends Modal {
  private ok = false;
  private done!: (v: boolean) => void;
  constructor(
    app: App,
    private readonly titleText: string,
    private readonly body: string,
    private readonly yes: string,
  ) {
    super(app);
  }
  static ask(app: App, title: string, body: string, yes = "OK"): Promise<boolean> {
    const m = new ConfirmModal(app, title, body, yes);
    return new Promise((r) => {
      m.done = r;
      m.open();
    });
  }
  onOpen() {
    this.setTitle(this.titleText);
    this.contentEl.createEl("p", { text: this.body });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText(this.yes)
          .setCta()
          .onClick(() => {
            this.ok = true;
            this.close();
          }),
      );
  }
  onClose() {
    this.contentEl.empty();
    this.done(this.ok);
  }
}

export const fmtTime = (secs: number) => {
  const d = new Date(secs * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

export class VersionPickModal extends SuggestModal<Version> {
  constructor(
    app: App,
    private readonly versions: Version[],
    private readonly currentHash: string | null,
    private readonly onPick: (v: Version) => void,
  ) {
    super(app);
    this.setPlaceholder("Pick a version to preview");
  }
  getSuggestions(q: string) {
    return this.versions.filter((v) => fmtTime(v.time).includes(q) || v.entry.d.toLowerCase().includes(q.toLowerCase()));
  }
  renderSuggestion(v: Version, el: HTMLElement) {
    el.createDiv({ text: `${fmtTime(v.time)}${v.entry.h === this.currentHash ? "  (current)" : ""}` });
    el.createEl("small", { text: `${v.entry.d} · ${fmtSize(v.entry.s)}` });
  }
  onChooseSuggestion(v: Version) {
    this.onPick(v);
  }
}

export class VersionPreviewModal extends Modal {
  constructor(
    app: App,
    private readonly path: string,
    private readonly v: Version,
    private readonly content: Uint8Array,
    private readonly onRestore: () => Promise<void>,
    private readonly onCopy: () => Promise<void>,
  ) {
    super(app);
  }
  onOpen() {
    this.setTitle(`${this.path} — ${fmtTime(this.v.time)}`);
    const text = new TextDecoder().decode(this.content.subarray(0, 20000));
    const pre = this.contentEl.createEl("pre");
    pre.style.maxHeight = "50vh";
    pre.style.overflow = "auto";
    pre.style.whiteSpace = "pre-wrap";
    pre.setText(/[\u0000-\u0008]/.test(text) ? `(binary file, ${fmtSize(this.content.length)})` : text);
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b.setButtonText("Save as a copy").onClick(async () => {
          await this.onCopy();
          this.close();
        }),
      )
      .addButton((b: ButtonComponent) =>
        b
          .setButtonText("Restore this version")
          .setCta()
          .onClick(async () => {
            await this.onRestore();
            this.close();
          }),
      );
  }
  onClose() {
    this.contentEl.empty();
  }
}

export class DeletedPickModal extends FuzzySuggestModal<DeletedFile> {
  constructor(
    app: App,
    private readonly files: DeletedFile[],
    private readonly onPick: (f: DeletedFile) => void,
  ) {
    super(app);
    this.setPlaceholder("Search deleted files");
  }
  getItems() {
    return this.files;
  }
  getItemText(f: DeletedFile) {
    return `${f.path}  (last seen ${fmtTime(f.last.time)})`;
  }
  onChooseItem(f: DeletedFile) {
    this.onPick(f);
  }
}

/** Shows the GitHub device code while waiting for approval. */
export class DeviceCodeModal extends Modal {
  constructor(
    app: App,
    private readonly code: string,
    private readonly uri: string,
    private readonly onCancel: () => void,
  ) {
    super(app);
  }
  onOpen() {
    this.setTitle("Sign in with GitHub");
    this.contentEl.createEl("p", { text: "Open the page below, sign in to GitHub, and enter this code:" });
    const c = this.contentEl.createEl("pre", { text: this.code });
    c.style.fontSize = "1.6em";
    c.style.textAlign = "center";
    c.style.userSelect = "all";
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Copy code").onClick(() => navigator.clipboard.writeText(this.code)))
      .addButton((b) => b.setButtonText(`Open ${new URL(this.uri).host}`).setCta().onClick(() => window.open(this.uri)));
    this.contentEl.createEl("p", { text: "Waiting for approval…", cls: "setting-item-description" });
  }
  onClose() {
    this.contentEl.empty();
    this.onCancel();
  }
}
