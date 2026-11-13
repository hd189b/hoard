# Hoard

**Encrypted multi-Git sync for Obsidian.** Hoard keeps your vault in two-way
sync between your devices (Linux, Windows, Android) and stores it in several
Git hosts at once: GitHub, GitLab, Codeberg, or any Git server. Each host holds
a full, end-to-end encrypted copy with all history, so losing one host loses
nothing.

- **Everything is encrypted before it leaves the device**, including file and
  folder names. Hosts see only opaque blobs; commits are all `hoard <sync@invalid>` / `sync`.
- **Conflicts never lose data.** Edit the same note on two devices and you get
  the note plus a `Name (conflict DATE DEVICE).md` copy. Delete on one device
  while editing on the other, and the edit wins.
- **Full history:** restore any older version of a note, or a deleted file,
  from inside Obsidian.
- **Several hosts, kept equal:** every sync fetches from and pushes to all of
  them; a host that was down catches up automatically.
- **Standalone decrypter** for Linux and Windows: read your vault and its
  history without Obsidian.

The design is described in [SPEC.md](SPEC.md).

---

## Contents

1. [Requirements](#requirements)
2. [Clone and build](#clone-and-build)
3. [Prepare your Git hosts](#prepare-your-git-hosts)
4. [Install the plugin](#install-the-plugin) on [Linux](#linux), [Windows](#windows), [Android](#android)
5. [First device, then the others](#first-device-then-the-others)
6. [Everyday use](#everyday-use)
7. [Settings](#settings)
8. [The standalone decrypter](#the-standalone-decrypter)
9. [Updating](#updating)
10. [Troubleshooting](#troubleshooting)
11. [Security notes and limits](#security-notes-and-limits)
12. [Development](#development)

---

## Requirements

| What | Needed for |
|---|---|
| Obsidian **1.11.4 or newer** | Running the plugin (desktop and Android) |
| **Node.js 20+** and **npm** | Building the plugin and running the tests |
| **Bun** (optional) | Building the decrypter as single-file executables |
| **Git** (optional, desktop only) | SSH remotes. HTTPS works without Git installed |

On Arch Linux, for example:

```bash
sudo pacman -S nodejs npm bun git
```

---

## Clone and build

```bash
git clone <your-repo-url> hoard
cd hoard
npm install
npm run build
```

The plugin is now in `dist/plugin/`:

```
dist/plugin/main.js
dist/plugin/manifest.json
```

Those two files are all a device needs. Optional:

```bash
npm run build:decrypter   # dist/decrypter/hoard-decrypt and hoard-decrypt.exe
npm test                  # 86 automated tests (needs git; SSH tests need sshd)
```

---

## Prepare your Git hosts

Use **one new, empty, private repository per host.** Two hosts (for example
GitHub and GitLab) is a good start.

1. **Create the repository.** Leave "Initialize with a README" **unticked**.
   If the host adds a README anyway, see
   [Host holds other content](#troubleshooting).
2. **Create an access token** that can read and write just that repository:

| Host | Token | Permissions |
|---|---|---|
| GitHub | Settings → Developer settings → **Fine-grained token** | Repository access: only this repo. Contents: **Read and write** |
| GitLab | Project → Settings → **Access tokens** (or a personal token) | Role Developer or higher; scopes `read_repository`, `write_repository` |
| Codeberg / Gitea / Forgejo | User settings → Applications → **Access token** | Repository: read and write |
| Any server over SSH (desktop only) | An SSH key, e.g. a **deploy key** with write access | Hoard can generate one for you |

Keep the tokens at hand; you'll paste one per host into each device's
settings. Tokens are stored only in that device's secret storage, never in
the vault or the repository.

---

## Install the plugin

On every device, the plugin goes into the vault's plugin folder:

```
<your vault>/.obsidian/plugins/hoard/main.js
<your vault>/.obsidian/plugins/hoard/manifest.json
```

Then in Obsidian: **Settings → Community plugins** → turn off Restricted
mode if it's on → refresh → enable **Hoard**.

> Back up your vault before the first sync. Hoard is new software.

### Linux

```bash
mkdir -p ~/path/to/vault/.obsidian/plugins/hoard
cp dist/plugin/main.js dist/plugin/manifest.json ~/path/to/vault/.obsidian/plugins/hoard/
```

**Where passwords and tokens are kept.** Hoard checks, in order:

1. **KeePassXC**, if it's running with Secret Service integration turned on
2. **KWallet**. If KWallet has no wallet yet, settings show **Create KWallet
   wallet**, which opens KWallet's own setup window.
3. **GNOME Keyring** (or another Secret Service keyring)
4. **Plain text** in `~/.config/hoard/`, readable only by you, with a warning

You can switch in settings; secrets are moved across. Needs `secret-tool`
(libsecret) for KeePassXC/GNOME Keyring and `kwallet-query` for KWallet.

### Windows

Copy the two files into `<vault>\.obsidian\plugins\hoard\` (with File
Explorer or PowerShell):

```powershell
mkdir "$env:USERPROFILE\path\to\vault\.obsidian\plugins\hoard"
copy dist\plugin\main.js, dist\plugin\manifest.json "$env:USERPROFILE\path\to\vault\.obsidian\plugins\hoard\"
```

- Secrets go into Obsidian's secret storage (protected by Windows).
- HTTPS hosts work as is. **SSH hosts need [Git for Windows](https://git-scm.com/download/win)**;
  set its path in settings if `git` isn't on `PATH`.
- A proxy can be set in Hoard's settings (`http://…` or `socks5://…`).

> Windows behaviour has been tested only in simulation so far (see
> [Security notes and limits](#security-notes-and-limits)).

### Android

Android hides folders starting with a dot, so copy from a computer.

**With USB debugging** (Developer options → USB debugging, then plug in):

```bash
adb shell mkdir -p /sdcard/Documents/YourVault/.obsidian/plugins/hoard
adb push dist/plugin/main.js dist/plugin/manifest.json /sdcard/Documents/YourVault/.obsidian/plugins/hoard/
```

Replace `YourVault` with your vault's folder (vaults created "on this device"
are usually under `Documents`). Or copy the files over USB file transfer into
the same folder; some file managers need "show hidden files".

Then restart Obsidian on the phone and enable the plugin.

On Android:
- Only **HTTPS** hosts (Android plugins can't run SSH). Use the phone's own
  proxy or VPN settings.
- Secrets go into Obsidian's secret storage on the phone.
- Files over **10 MB** are left on the hosts by default (Obsidian for Android
  can crash on big downloads). You can change the limit, but keep it modest.
- There's no status bar on phones; use the **ribbon icon** (↻) to sync.

---

## First device, then the others

**Set up one device completely first.** Ideally the others start from an
empty vault, so their notes simply arrive (otherwise every note that differs
becomes a conflict copy: nothing lost, but untidy).

### First device

1. Settings → Hoard:
   - **Device name**: e.g. `Laptop` (used in conflict copy names).
   - **Git hosts → Add host** for each repository: paste the HTTPS URL, choose
     the sign-in method, paste the token, press **Save**, then **Test**. It
     should say *the repository is empty and will be set up on the first sync*.
2. Run **Sync now** (ribbon icon or command palette).
3. Choose a **vault password** (at least 10 characters; a few random words work well).
4. Hoard shows a **recovery key** (`EGR1-…`). **Store it outside the vault**
   (password manager, paper). It opens the vault if you forget the password.

### Every other device

1. Install the plugin, set the device name, add the **same hosts** with tokens.
2. **Test** should now say *holds this encrypted vault*.
3. Run **Sync now** and enter the vault password. Everything is downloaded.
4. Keep "Remember the vault key on this device" on to avoid typing the
   password again (or off to be asked once per session).

---

## Everyday use

**Syncing.** By default Hoard syncs when Obsidian starts, 30 seconds after
you stop editing, and every 10 minutes. You can always run **Sync now**. The
status bar (desktop) shows `✓ 14:05`, `⟳ Syncing…`, `⚠ 1 host failing`, or
`🔒 Locked`; hover for each host's state, click to sync.

**Conflicts.** If a note changed on two devices before syncing, the version
already on the hosts keeps the name and yours is saved next to it as
`Note (conflict 2026-11-14 0110 Laptop).md`. A notice tells you; merge the
two by hand and delete the copy.

**Commands** (command palette, search "Hoard"):

| Command | What it does |
|---|---|
| Sync now | Sync with every host |
| Restore older version of this note | Pick a version, preview it, restore it or save it as a copy |
| Restore deleted file | Pick from every file that ever existed and is now gone |
| Change vault password | Re-locks the vault key; notes aren't re-encrypted |
| Show recovery key | Shows the `EGR1-…` key again |
| Lock vault | Forgets the key on this device; the password is asked at the next sync |
| Show sync status of each host | One line per host |

**Notices you may see**

- *was changed on two devices… saved as …*: a conflict copy was made.
- *GitHub: Can't reach the host…*: that host is skipped this time; it's
  retried after 1, 2, 5, then 10 minutes and caught up when it's back.
- *… reachable again and up to date*: a host has caught up.
- *renamed … so it also works on Windows and Android*: a name with `: * ? " < > |`
  or a clash that differs only by letter case got a safe name.
- *files were damaged on this device and restored*: a write went wrong
  locally (seen on Android) and Hoard fixed it from the encrypted copy.
- *Tidying up local history…*: the local repository is being compacted
  (every 200 syncs or so; can take a minute on a phone).

---

## Settings

| Setting | Default | Notes |
|---|---|---|
| Device name | Linux / Windows / Phone | Shown in conflict copy names (stored encrypted) |
| Password storage | automatic | Linux only: KeePassXC → KWallet → GNOME Keyring → plain text |
| Remember the vault key | on | Off: asked for the password once per session |
| Git hosts | — | Name, URL(s), sign-in method, engine, on/off, **Test** |
| Sync every | 10 min | 0 turns it off |
| Sync when Obsidian starts | on | |
| Sync after edits | 30 s | Seconds after you stop typing; 0 turns it off |
| Ignored folders | none | Never uploaded, downloaded or deleted by this device |
| Maximum file size | 50 MB (phones: 10 MB) | Bigger files stay on the hosts for this device |
| Sync the `.obsidian` folder | off | Settings, themes, plugins. Window layout and Hoard's own folder are never synced |
| Proxy | none | Desktop: `http://host:port` or `socks5://host:port` |
| Git program | `git` on PATH | Desktop, for SSH hosts |
| Password key strength | Standard (64 MB) | Strong (128 MB) for desktop-only vaults |
| GitHub OAuth app client ID | empty | Needed only for "Sign in with GitHub" |

### Sign-in methods

| Method | Use with | Platforms |
|---|---|---|
| Access token | GitHub, GitLab, Codeberg, Gitea, any HTTPS Git | all |
| Sign in with GitHub | GitHub (needs your own OAuth app with Device Flow enabled; paste its client ID in settings) | all |
| Username and password | Servers that still accept passwords (not GitHub or GitLab.com) | all |
| SSH key | Any SSH Git server. Use your key, or **Generate a key for this vault** and add the public key as a deploy key | Linux, Windows |

Several URLs can be listed for one host (one per line); each is fetched and
pushed. Credentials are never put in URLs, command lines, Git config or logs.

---

## The standalone decrypter

Reads a Hoard vault from any one of your hosts, without Obsidian. It never
changes the repository.

```bash
npm run build:decrypter                   # needs Bun
git clone --mirror <host url> vault-backup
./dist/decrypter/hoard-decrypt vault-backup
```

Use `--mirror`: large files (over 8 MB) are kept outside the main history,
and a normal clone leaves them out (the decrypter tells you which).

The default command opens a page in your browser on `127.0.0.1` (only your
computer can reach it): unlock with the password or the recovery key, pick
any sync, browse files, view or download any version, see deleted files,
export a whole sync to a folder.

Command line:

```bash
hoard-decrypt list    REPO [--at SYNC]          # files in a sync (default: latest)
hoard-decrypt syncs   REPO                      # every sync with its date
hoard-decrypt history REPO PATH                 # every version of a file
hoard-decrypt cat     REPO PATH [--version N]   # print a file (N=1 is newest)
hoard-decrypt deleted REPO                      # deleted files
hoard-decrypt export  REPO DIR [--at SYNC]      # write a whole sync to DIR
```

The password is asked interactively; for scripts set `HOARD_PASSWORD` or
`HOARD_RECOVERY_KEY` (or pass `--recovery-key` to type a recovery key).
On Windows use `hoard-decrypt.exe` the same way.

---

## Updating

```bash
git pull
npm install
npm run build
```

Copy `dist/plugin/main.js` and `manifest.json` into each vault again (same
places as above) and restart Obsidian. Settings and secrets are kept.

---

## Troubleshooting

| Message | What to do |
|---|---|
| **Sign-in was rejected: the token or password is wrong or has expired** | Paste a fresh token and press Save. |
| **Signed in, but this token isn't allowed to use this repository** | The token is valid but lacks write access to *this* repo. Edit the token (GitHub: Contents → Read and write, repository included). |
| **Host holds other content, not an encrypted vault** | The repo isn't empty (e.g. the host added a README). If that content isn't needed: settings → that host → **Test → Replace with this vault**. If the host protects `main` (GitLab does), allow force-push there first, replace, then protect it again. |
| **This repository holds a different vault** | That URL belongs to another Hoard vault. Use a different repo. |
| **Can't set up a new vault while … can't be reached** | A new vault is only created when every host is reachable (one might already hold your vault). Fix the host or disable it. |
| **Wrong password** | Try again, or use the recovery key in the decrypter. |
| **KWallet has no wallet yet** | Settings → Password storage → **Create KWallet wallet**. |
| **SSH hosts can't be used on Android** | Add an HTTPS URL for that host on the phone. |
| **A large file isn't on any reachable host yet** | It will be fetched at a later sync. |
| Obsidian on the phone feels slow right after a sync | The first sync of a big vault takes a while (≈30 s for 1,500 notes). |

---

## Security notes and limits

**What's protected:** note contents, file and folder names, folder structure,
device names. Keys: a random 256-bit vault key, wrapped with a key derived from
your password (Argon2id); files encrypted with AES-256-GCM with the path
bound in; names replaced by keyed hashes.

**What hosts can still see:** how many encrypted files there are, their sizes,
when you sync, and which hosts you use.

**Limits**

- Forget the password **and** lose the recovery key, and the backups can't be read.
- After a password change, the *old* password still opens *old* history
  (the old key file stays in Git history).
- A malicious host can't read anything, but could withhold or roll back data;
  whole-history integrity isn't verified.
- Don't sync the same vault with another tool at the same time (Obsidian Sync,
  Syncthing, iCloud…).
- No independent security review yet.

**Test status**

Tested: Linux desktop (your own Obsidian install, KWallet), Obsidian for
Android on an emulator, GitHub and GitLab, SSH and proxies against local
servers, killing Obsidian mid-download/write/upload, a 6,400-note vault,
months of simulated history, and the decrypter.

Not yet tested on real hardware: a physical Android phone, Windows (simulated
only), macOS and iOS, KeePassXC, and Sign in with GitHub.

---

## Development

```bash
npm install
npm test            # unit + integration tests (real Git servers via git http-backend)
npm run typecheck
npm run dev         # rebuild the plugin on every change
```

| Folder | Contents |
|---|---|
| `src/core/` | Encryption, repo format, merge, sync engine (no Obsidian or Node dependencies) |
| `src/platform/` | Desktop-only code: Node HTTP with proxies, system Git (SSH), Linux keyrings |
| `src/plugin/` | The Obsidian plugin: settings, modals, Android adapters |
| `src/decrypter/` | The standalone decrypter (CLI and local web page) |
| `test/` | Tests; `test/helpers/` simulated devices, Git/SSH servers, proxies, NTFS |
| `test/e2e/` | Helpers used to drive real Obsidian (desktop and Android) during manual testing |

Some identifiers inside the stored format keep the project's original working
name (`refs/encgidian/…`, the `encgidian-keys` key file tag, encryption
labels). They are part of the on-disk format and intentionally unchanged.
