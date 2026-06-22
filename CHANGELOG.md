# Changelog

All notable changes to `vector-migrate` are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.1] - 2026-06-22

### Changed

- Docs: the README now recommends **`npx vector-migrate@latest`** everywhere
  (especially for Windows users) so a cached older `npx` build can't mask the
  v2.1 SSH/branch fixes. No code changes.

## [2.1.0] - 2026-06-22

Robust, multi-key SSH detection with accurate, unambiguous failure guidance.

### Fixed

- **The preflight no longer pins to a single key.** Previously it considered only
  `id_ed25519` and reported it as "the" key; a user whose on-disk key wasn't
  registered with GitHub got a misleading message. The auth probe now runs ssh
  with `IdentitiesOnly=no` so it offers the **ssh-agent and every default key**
  (`id_ed25519`, `id_rsa`, `id_ecdsa`, `id_dsa`), and passes if **any** of them is
  registered — matching how the real clone/push authenticate.
- **Accurate failure guidance.** When no local key is accepted, the message now
  lists **every** local public key with the exact OS-correct print command
  (`type %USERPROFILE%\.ssh\<name>.pub` on Windows, `cat ~/.ssh/<name>.pub` on
  posix), states plainly that none is registered, and links directly to where to
  register one — GitHub `https://github.com/settings/keys`, or Azure DevOps
  User settings -> SSH public keys. No more calling one key "the key" when several
  exist.

### Added

- **`--ssh-key <path>`** is honored explicitly end-to-end: it's validated for
  existence and forced into both the auth probe and the push
  (`-i <path> -o IdentitiesOnly=yes`).
- `--check` now lists every local SSH public key it finds.
- Unit tests covering: unregistered key (the reported Windows-cmd case),
  registered key, multiple keys, no key, OS-correct rendering, and `--ssh-key`.

## [2.0.0] - 2026-06-22

Windows robustness release. Two real problems Windows users hit are now handled
automatically, with cross-platform, OS-aware guidance.

### Added

- **SSH preflight with key-generation guidance.** Before any mirror clone, Vector
  detects a usable SSH key (an explicit `--ssh-key` path, a standard `~/.ssh/id_*`
  key, or one held by `ssh-agent`). If none is found it stops immediately and
  prints the exact setup steps for your OS — the `ssh-keygen -t rsa -b 4096`
  command (with an `ed25519` alternative), the right "show your public key"
  command (`type %USERPROFILE%\.ssh\id_rsa.pub` on Windows `cmd`, `cat ~/.ssh/id_rsa.pub`
  on bash/macOS), and how to register the key with both Azure DevOps and GitHub.
- **Host-key trust.** `github.com` (always) and `ssh.dev.azure.com` (only for an
  SSH Azure source) are trusted non-interactively, so a fresh machine never dies
  on `Host key verification failed`.
- **Azure auth verification.** When the Azure source URL is SSH, Vector verifies
  Azure SSH auth up front and, on failure, explains both fixes (add the key to
  Azure, or switch the source URL to HTTPS). HTTPS Azure sources skip all Azure
  SSH checks.
- **Automatic case-insensitive branch-conflict resolution.** Vector detects branch
  names that break `git filter-repo` on case-insensitive (Windows/macOS)
  filesystems — case-only collisions (`Mbouzine` vs `MBouzine`) and directory/file
  collisions (`MBouzine` vs `MBouzine/init_repo`) — and resolves them instead of
  crashing. On Windows it first attempts case-sensitive ref storage for its scratch
  copy via `fsutil setCaseSensitiveInfo`; remaining conflicts are resolved by user
  choice, defaulting to renaming with a `-N` suffix so every branch still migrates
  (with Skip and Abort alternatives).
- **Richer `--check`.** The preflight report now includes SSH key detection and
  Azure SSH status (when the source is SSH).
- New tests for the conflict detector/resolver and for SSH-key detection.

### Changed

- `GIT_SSH_COMMAND` now sets `StrictHostKeyChecking=accept-new`, so clone/push
  trust a never-before-seen host on first contact without a prompt.
- The `git filter-repo` invocation is wrapped: a residual `cannot lock ref` error
  now produces a friendly, actionable explanation instead of a raw stack trace.

### Fixed

- Migrations no longer crash with `cannot lock ref 'refs/heads/X': 'refs/heads/x'
  exists` on Windows when a repository contains case- or path-prefix-colliding
  branches.
- Keyless or mis-configured-SSH runs fail fast with guidance instead of failing at
  the push after a full mirror clone.

[2.1.1]: https://github.com/YRACHEK101/Vector/releases/tag/v2.1.1
[2.1.0]: https://github.com/YRACHEK101/Vector/releases/tag/v2.1.0
[2.0.0]: https://github.com/YRACHEK101/Vector/releases/tag/v2.0.0
