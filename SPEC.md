# Project: Encrypted multi-Git sync plugin for Obsidian (v2 design)

## Goal
An Obsidian plugin that keeps a vault in two-way sync across
**Windows, Linux and Android**, storing it in several Git hosts at once
(GitHub, GitLab, Codeberg, any Git server). If one host is lost, the
others still have everything. Nothing readable ever leaves the device.

## Requirements
- Two-way sync. Edits on any device reach the others.
- Conflicts never lose data. If a note was edited on two devices before
  either synced, keep one version and save the other as
  `name (conflict YYYY-MM-DD HHmm DEVICE).md`. If one side deleted a
  note and the other edited it, keep the edit.
- Name clashes are never overwritten: if a name is already taken, add
  ` (1)`, ` (2)`, … before the extension, like a browser does with
  repeated downloads (`note.md` → `note (1).md` → `note (2).md`).
- Every sync pulls from all enabled remotes, merges, and pushes to all
  of them. One host being down must not stop the others; it catches up
  on the next sync.
- Full history (each sync = one commit). Restore older versions or
  deleted files from inside Obsidian.
- Everything on the Git host is encrypted, including file and folder
  names. Commit messages and author info reveal nothing.
- HTTPS and SSH remotes. Proxy support (HTTP and SOCKS5).
- The password can be changed without re-encrypting the vault.

## Platforms

| | Windows | Linux | Android |
|---|---|---|---|
| Built-in Git engine (isomorphic-git, HTTPS) | yes | yes | yes |
| System Git engine (`git` CLI) | yes, Git for Windows | yes | no |
| SSH remotes | yes, via system Git | yes, via system Git | no |
| Proxy setting in plugin | yes | yes | no, use the phone's proxy/VPN |
| Git install required | only for SSH | only for SSH | never |

- **Two Git engines behind one interface.** The built-in engine runs
  everywhere and uses Obsidian's `requestUrl` for HTTP (no CORS proxy
  needed). The system engine is used on desktop when a remote is SSH,
  or when the user picks it. Both read and write the same repo format.
- **Proxy on desktop:** passed to system Git as `http.proxy`
  (`http://` or `socks5h://`); the built-in engine on desktop uses a
  Node HTTP/SOCKS proxy agent.
- **Secret storage is per device and never synced.**
  - Windows and Android: Obsidian's secret-storage API (Windows
    credential protection / the phone's secure storage). Nothing to
    install.
  - Linux: the plugin picks a backend itself, checked in this order on
    first setup:
    1. **KeePassXC** (its Secret Service integration must be on, and
       the database unlocked), via `secret-tool`.
    2. **KWallet**, via `kwallet-query`.
    3. **GNOME Keyring** (or any other Secret Service keyring), via
       `secret-tool`.
    4. **Plain text**: a file outside the vault
       (`~/.config/encgidian/secrets-<vault id>.json`, readable only by
       your user), with a red warning in settings.

    Settings show which backend is in use and which others were found,
    with a dropdown to switch (secrets are moved across). The choice is
    remembered on that device. If the chosen backend is unavailable
    later (for example KeePassXC isn't running), the plugin asks for
    the password for this session instead of silently switching.

  Secrets never go into the plugin's `data.json`, so syncing the
  `.obsidian` folder copies the remote list and settings but not
  passwords or tokens. On each new device you type the vault password
  and the tokens once.
- **Linux paths:** case-sensitive file names are kept as-is. When a
  path would clash on Windows/Android (`Note.md` vs `note.md`), the
  receiving device saves the second one as `note (1).md` and shows a
  notice. Characters Windows forbids (`: * ? " < > |`) are replaced
  with `_` on that device, again adding ` (n)` if the result is taken.

## Encryption design

### Keys
- **Vault key:** 32 random bytes, made once when the first device sets
  up an empty repo. It never changes in v1.
- **Password key:** derived from the password with **Argon2id**
  (`hash-wasm`, works on desktop and Android). Default parameters:
  64 MiB memory, 3 iterations, 1 lane. Parameters and a random 16-byte
  salt are stored in the repo so they can be raised later.
- **Key file** (`/keys.json`, plaintext JSON, no secrets): format
  version, Argon2id parameters, salt, and the vault key encrypted with
  the password key (AES-256-GCM). A wrong password fails the GCM check
  on unwrap, which gives a clear "wrong password" error. No separate
  password-check value is needed.
- **Sub-keys** derived from the vault key with HKDF-SHA256:
  `content` (file encryption), `names` (HMAC for file IDs),
  `manifest` (manifest encryption).

### Changing the password
Re-encrypt only the vault key with the new password key, write a new
`keys.json`, commit and push. Notes are not touched.
**Caveat:** old commits still contain the old `keys.json`, so the old
password still unlocks history. Changing the password protects against
someone learning the new one, not against a leaked old one. Fixing that
needs a new vault key and a full re-encrypt; that is out of scope for v1.

### Files
- File ID = HMAC-SHA256(`names` key, normalized path), hex, first 32
  chars. Stored at `/o/<id[0:2]>/<id>`.
- Each file is encrypted with AES-256-GCM using the `content` key and a
  random 12-byte IV. **The path is bound in as associated data**
  (format version + file ID + path), so an encrypted file swapped into
  another file's place fails to decrypt instead of showing the wrong
  content.
- A rename means re-encrypting under the new path. That is fine,
  because files are small and renames are rare.

### Sharded manifest
- The manifest maps each path to: size, modified time, content hash
  (HMAC of the plaintext, so edits can be detected without
  decrypting), and the last-changing device. The file ID is computed
  from the path.
- It is split into **256 shards by the first two hex characters of the
  file ID**, stored at `/m/<xx>`. Each shard is encrypted on its own,
  with the shard number as associated data.
- A sync only rewrites the shards that changed. A device only decrypts
  the shards whose Git blob hash differs from the last sync, so big
  vaults stay fast on Android.
- No delete markers are needed: a delete is "in the base, missing on
  one side", and the base comes from Git history.

### Local repository
Each device keeps a bare Git repo (objects and refs only, no checkout
of encrypted files) in the plugin's folder:
`.obsidian/plugins/encgidian/repo/`. The plugin folder is always
excluded from syncing, even when `.obsidian` syncing is on.

### What the host can see (accepted)
Number and sizes of encrypted files, number of shards in use, sync
times, and which remotes the user has. No names, folder structure,
text or device names.

## Sync and merge
1. Scan the vault and build the local manifest (skipping ignored
   folders, files over the size limit, and `.obsidian` unless enabled).
2. Fetch every enabled remote, in parallel, each with its own timeout.
   Failures are recorded per remote and do not stop the others.
3. Commit local changes on top of the local head (the **local side**).
4. Merge each fetched remote head into it, one at a time, as a
   three-way merge at the manifest level. **Base** = the manifest at the
   Git merge-base of the two commits (their last shared sync), found
   from Git history, not from a locally saved copy. This stays correct
   even when two devices pushed to different remotes at the same time.
   Changes are detected by content hash, not file times.
   - Changed on one side only → take it.
   - Same content hash on both sides → no conflict.
   - Changed on both sides to different content → **conflict**: the
     version already on the remote stays as the note; this device's
     version is saved as the conflict copy, and a notice names both
     files. The rule doesn't depend on device clocks, so every device
     gets the same result.
   - Deleted on one side, edited on the other → keep the edit.
   - Added on both sides with the same path and different content →
     conflict, same rule.
   - Renamed on one side, edited on the other → the edit follows the
     new name (renames are matched by content hash).
5. Write changed files to the vault and changed objects/shards to the
   repo, then make one merge commit whose parents are the local commit
   and every fetched remote head, so it fast-forwards on every remote.
   Author `encgidian <sync@invalid>`, message `sync`.
6. Push to every enabled URL whose head isn't already the new commit.
   If a push is rejected because another device pushed first, fetch
   that URL again and repeat from step 4 (up to 3 times).
7. If every push fails, the local commit stays and is pushed next time.

### Redundancy: every host holds the same history
- All hosts get **the same commits**; each is a full, independent copy.
  Any one of them is enough to restore everything.
- Every sync, **even one with no local changes**, compares each host's
  head with the merged head and pushes to any host that is behind.
- **Host missed syncs** (network error, outage): on its next
  successful contact it gets one push that brings it up to the latest
  commit, with all the history it missed.
- **Host has commits the others lack** (for example the phone could only
  reach GitLab for a while): those commits are fetched, merged, and
  pushed on to every other host.
- A failed host is retried sooner than the normal interval (after 1, 2,
  5, then 10 minutes) until it succeeds. The status bar shows each
  host's state: up to date, behind, or failing with the error.

### Example: both devices edit the same note before syncing
- Last sync: both have `Plan.md` = A.
- PC edits it to B, the phone edits it to C. Neither has synced.
- PC syncs first: base A, local B, remote A → only PC changed it →
  pushes B. No conflict yet.
- Phone syncs: fetches the PC's commit. Base A (their last shared
  sync), local C, remote B → both changed → conflict.
  `Plan.md` = B (already on the remote), and the phone's edit is saved
  as `Plan (conflict 2026-11-13 2215 Phone).md` = C. Notice shown.
- Phone pushes; PC's next sync receives the conflict copy as a normal
  new file. Nothing is lost, and both devices end up with the same two
  files.
- If both sync at the same moment, one push is rejected, that device
  fetches again and ends up in the case above.
- If the two devices pushed to *different* remotes at the same moment
  (say PC → GitHub while the phone → GitLab), the next sync on either
  device fetches both heads, finds their merge-base through Git
  history, and creates the same conflict copy.

A lock file stops two syncs running at once (for example, the timer
and an after-edit sync).

## Remotes
- Each remote: name, URL, optional extra URLs (each one is both
  fetched and pushed, so none can fall behind unnoticed), sign-in
  method (below), on/off, engine (auto / built-in / system), and a
  **Test** button that checks connection, sign-in and the repo format.

### Sign-in methods
| Method | Works with | Platforms |
|---|---|---|
| Access token (personal / project / deploy token) | GitHub, GitLab, Codeberg, Gitea, any HTTPS Git | all |
| Sign in with GitHub (browser login, device code) | GitHub | all |
| Username + password | servers that still allow it (Gitea, Forgejo/Codeberg without 2FA, self-hosted); GitHub and GitLab.com do not | all |
| SSH key | any SSH Git server | Windows, Linux |

- **Sign in with GitHub:** the plugin shows a short code and opens
  `github.com/login/device`. You approve there and the plugin receives a
  token. No password ever touches the plugin. This needs an OAuth app
  registered on GitHub once (its public client ID is built into the
  plugin; there is no client secret). The token's scope is `repo`,
  which is broader than a fine-grained token for one repo, so settings
  recommend a fine-grained token when you want the tightest access.
- **SSH key**, two choices:
  - *Use my key file:* path to an existing key. If it has a
    passphrase, the passphrase is stored encrypted. If it has none,
    the plugin warns and suggests adding one.
  - *Generate a key for this vault:* the plugin creates an ed25519
    key with a random passphrase (stored encrypted) and shows the
    public key to paste into the host (for example a GitHub deploy key
    limited to this one repo).
  The passphrase is handed to `ssh` through a one-shot askpass helper,
  never on the command line or in a file.

### Credentials are always encrypted
- **At rest:** tokens, passwords and SSH passphrases are kept only in
  the device's secret storage (see Platforms; on Linux KeePassXC →
  KWallet → GNOME Keyring → plain-text fallback). They are never written
  to `data.json`, the vault, the repo, or Git config. SSH private keys
  stay on disk encrypted with their passphrase.
- **In transit:** only `https://` and `ssh://` URLs are accepted.
  Sign-in over plain `http://` is refused (except `localhost`, for
  testing).
- **While in use:** credentials are held in memory only while a sync
  runs. They are passed to the built-in engine through its sign-in
  callback, and to system Git through a credential helper that reads
  them from the child process's environment. They never appear in a
  URL, command line, or log, and error messages are scrubbed of them.
- **Lock vault** clears the vault key and all credentials from memory.
- Empty repo: the first device sets it up (key file, empty manifest).
  A repo with the same vault key on other remotes is joined.
  A repo with a different vault key is refused with a clear error, so
  two different vaults can never be mixed.

## Features
- Settings: device name, remotes (above), auto-sync interval, sync on
  startup, sync N seconds after edits, proxy (desktop), SSH key path
  (desktop), ignored folders, maximum file size, sync `.obsidian`
  folder, Argon2id strength, secret backend (Linux).
- Password and tokens kept in secret storage. Option to not remember
  the password (asked once per session).
- Status bar: last sync time and per-remote state; click to sync now.
- Commands: Sync now, Restore older version of this note, Restore
  deleted file, Change password, Lock vault (forget keys in memory).
- Clear notices for errors per host and for each conflict copy.

## Standalone decrypter (Windows and Linux)
A separate app for reading a vault without Obsidian, for example years
later or on a machine without the plugin.
- Input: a local clone of any one of the hosts (a normal or bare Git
  repo folder).
- Unlock with the vault password or the recovery key.
- Browse the file tree as it was at any sync, with each sync's date.
- For any file: list every version, view it (text and images shown in
  the app), and save any version to disk.
- Show deleted files and the last version before deletion.
- Export the whole vault as of any sync to a folder.
- Read-only: never writes to the repo.
- Shares the plugin's encryption and format code, so both always agree.
- Delivered as one executable per platform (`encgidian-decrypt` for
  Linux, `encgidian-decrypt.exe` for Windows). It opens its interface
  in your web browser on `127.0.0.1` only, and also has command-line
  commands (`list`, `history`, `cat`, `export`).

## Known limits
- Forgetting the password makes all backups unreadable. The plugin
  offers an optional recovery key export (the vault key, shown once,
  to store offline).
- An old password still opens old history (see "Changing the password").
- File sizes and sync times are visible to the host.
- SSH needs Git installed on desktop; it is not available on Android.
- First sync of a big vault on Android may be slow.

## Testing
- Automated, on Linux in CI: two simulated devices syncing through two
  local Git servers (HTTP), covering edits, deletes, renames, conflicts,
  delete-vs-edit, both devices editing before syncing, both pushing at
  once to different servers, `(n)` name clashes, case-only clashes,
  one server down then back, empty repo, wrong password,
  password change, mismatched vault key, and a swapped encrypted file.
- Both Git engines tested against the same scenarios, and a repo
  written by one engine read by the other.
- SSH: a local SSH Git server with a test key. Proxy: local HTTP and
  SOCKS5 proxies, checking traffic actually goes through them.
- Redundancy: one host misses several syncs, then comes back and is
  brought fully up to date; one host gets commits the others lack,
  which then spread to all hosts.
- Decrypter: reads repos made by the plugin, every version of every
  file, deleted files, wrong password, recovery key.
- Linux secret backends: detection order, switching, and the
  plain-text file's permissions.
- Credentials: every sign-in method against local test servers; a scan
  of `data.json`, the repo, Git config, process command lines and logs
  for any test token or password.
- Leak check: scan every object in the repo history for any test file
  name, folder name, note text or device name.
- Manual check on real Windows, Linux and Android before release.

## Changes from v1 of this spec
- Random vault key protected by the password, so the password can be
  changed (removes the "no password change" limit).
- Argon2id (`hash-wasm`) instead of PBKDF2.
- Path bound into each file's encryption.
- Manifest split into 256 encrypted shards.
- Multiple push URLs per remote.
- Linux added as a supported platform; two Git engines.
- Password check is now the key unwrap itself.
- Linux secret backend order: KeePassXC → KWallet → GNOME Keyring →
  plain text.
- Explicit redundancy rules: every host is brought up to the latest
  commit on every sync; missed syncs are caught up.
- No delete markers (deletes come from Git history).
- Standalone decrypter for Windows and Linux.
- Sign-in methods: access token, Sign in with GitHub, username +
  password, SSH key (own or generated); credentials encrypted at rest,
  in transit and kept out of URLs, command lines and logs.
