# Encgidian — encrypted multi-Git sync for Obsidian

Two-way sync of an Obsidian vault across Windows, Linux and Android, stored
end-to-end encrypted in several Git hosts at once (GitHub, GitLab, Codeberg,
any Git server). Each host holds a full copy with all history. The full design
is in [SPEC.md](SPEC.md).

## Build

```bash
npm install
npm test                 # 63 tests: two devices, real Git servers, SSH, proxies
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
git clone <any of your hosts> vault-backup
./encgidian-decrypt vault-backup               # opens a browser interface on 127.0.0.1
./encgidian-decrypt history vault-backup Notes/Plan.md
./encgidian-decrypt export vault-backup ~/restored --at <sync id>
```

Read-only; accepts the password or the recovery key. `--help` lists all commands.

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

Not yet tested: on Android, on Windows (SSH askpass, Git Credential Manager,
`connect.exe` proxy), real KeePassXC / KWallet / GNOME Keyring, and Sign in
with GitHub (needs your OAuth client ID).
