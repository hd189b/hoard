# Encgidian — encrypted multi-Git sync for Obsidian

Two-way sync of an Obsidian vault across Windows, Linux and Android, stored
end-to-end encrypted in several Git hosts at once (GitHub, GitLab, Codeberg,
any Git server). Each host holds a full copy with all history. The full design
is in [SPEC.md](SPEC.md).

## Build

```bash
npm install
npm test                 # 86 tests: two devices, real Git servers, SSH, proxies
npm run build            # plugin -> dist/plugin/{main.js,manifest.json}
npm run build:decrypter  # dist/decrypter/encgidian-decrypt(.exe)
```

## Install the plugin

Copy `dist/plugin/main.js` and `dist/plugin/manifest.json` into
`<vault>/.obsidian/plugins/encgidian/`, then enable **Encrypted Multi-Git Sync**
under Settings → Community plugins. Needs Obsidian 1.11.4 or newer.
On Android, copy the same two files into the vault's `.obsidian/plugins/encgidian/`
folder (for example with a file manager), then enable the plugin.

## First setup

1. Create a new, empty, **private** repository on each host.
2. Settings → Encrypted Multi-Git Sync → **Add host**: paste the URL, choose a
   sign-in method, save the token / password / SSH key, press **Test**.
3. Run **Sync now**. The first device asks for a new vault password and shows a
   **recovery key** — keep it somewhere safe.
4. On every other device: add the same hosts, run **Sync now**, enter the password.

Settings (hosts, sign-ins, device name) are per device; secrets never leave the device.

## Standalone decrypter

```bash
git clone --mirror <any of your hosts> vault-backup   # --mirror also fetches large files
./encgidian-decrypt vault-backup               # opens a browser interface on 127.0.0.1
./encgidian-decrypt history vault-backup Notes/Plan.md
./encgidian-decrypt export vault-backup ~/restored --at <sync id>
```

Read-only; accepts the password or the recovery key. `--help` lists all commands.

## Phones and big vaults

Obsidian for Android crashes when a single download is much above ~20 MB, so the
plugin keeps every transfer to about 8 MB: large syncs are split into "step"
commits that devices download one at a time, and files over 8 MB are stored
outside the main history (their own Git ref), downloaded only by devices whose
size limit allows them. Phones default to a 10 MB limit. The local repo is
compacted automatically every 200 syncs or when 30 packs pile up (shown as
"Tidying up local history…"; about 1.5 minutes on a phone with 14,000 objects).

## Tested vs. not yet tested

Tested automatically on Linux: syncing between simulated devices through real
Git servers (edits, deletes, renames, conflicts, mid-sync edits, case clashes,
hosts down and catching up, split hosts, wrong password, mixed-up vaults,
password change), both Git engines, SSH with a passphrase key, HTTP and SOCKS5
proxies, token sign-in, Linux secret stores (with stand-in tools), a scan of
every object on the hosts for readable names/text, the decrypter, and that the
plugin bundle loads without Node modules (as on Android).

Tested by hand in Obsidian 1.15.1 on Linux (throwaway profile, driven over
Electron's debug port, see `test/e2e/`): settings screen, saving tokens, the
Test button, first-time vault setup and recovery key, conflict with another
device while the note was open, synced deletes, restoring an older version and
a deleted file, a host going down and catching up, lock/unlock, sync after
edits, and that no secrets or readable names end up on disk or on the hosts.

Tested by hand in Obsidian 1.15.1 for Android (emulator, Android 17, driven
over adb and the WebView debugger): plugin loads without Node modules, settings
on a phone screen, tokens in Obsidian's secret storage, joining an existing
vault, a real desktop-vs-Android conflict and delete-vs-edit (both vaults ended
up identical), restore picker, remembered key across an app restart.
Note: Obsidian saves its secret storage with a short delay; if the app is killed
within seconds of unlocking, you're asked for the password once more.

Tested for real between Obsidian 1.15.1 on Linux (the user's own install,
KWallet for secrets) and Obsidian for Android (emulator), syncing through
GitHub and GitLab: 305-note vault set up and joined (~19 s on the phone),
edits on both sides, same-note conflict, delete vs edit, folder rename vs edit
(both directions), a photo from the phone, the phone offline (airplane mode)
then back, GitHub blocked for Linux only (the phone forwarded the change),
password change, replacing a GitLab starter README, and the decrypter reading
the real history with the password and the recovery key. After every round the
two vaults were compared by SHA-256 and were identical.

Problems found that way and fixed: Obsidian for Android occasionally writes a
file as empty (notes and Git objects); every write is now read back and
retried, damaged files are restored from the encrypted copy, and a damaged
local repo rebuilds itself from a host. Also: secret ids over Obsidian's
64-character limit, KWallet without a wallet, KWallet's own Secret Service
mistaken for GNOME Keyring, missing KWallet entries treated as errors, vague
sign-in errors (now: wrong token vs. token without access to the repo).

Stress-tested on the Android emulator: Obsidian killed mid-download, mid-write
and mid-upload (each recovered on the next sync, repo intact, no data lost); a
6,400-note vault with 4–20 MB files; 400 syncs of history; compaction.
Windows was simulated on Linux (case-insensitive NTFS behaviour, locked files,
Windows paths in SSH/proxy commands).

Not yet tested: a physical Android phone, real Windows (Obsidian, Git for
Windows' askpass and `connect.exe`, DPAPI secret storage, the `.exe` decrypter),
KeePassXC, and Sign in with GitHub (needs your OAuth client ID).
