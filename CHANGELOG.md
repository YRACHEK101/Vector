# Changelog

All notable changes to `vector-migrate` are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.3.1] - 2026-06-23

### Fixed

- **Auto-unify all of your names under one email.** When you provide your new
  NAME + EMAIL, the interactive flow now unifies **every** author name found under
  your email(s) — your source email *and* your new email (for the common case
  where you already committed under that email with a different display name) — to
  your chosen identity. Previously a second name sharing your email (or a stray
  name on your new email) could be left un-unified, then correctly flagged by the
  safety check with no easy way to fix it.
- The interactive remap step **groups other authors by email** (showing every name
  per email so none is missed) and **includes the detected "you" identity** in the
  unification when its name differs from your chosen name; other people are kept
  unless you explicitly remap them.
- The safety check now names the exact `Name <email>` pair(s) that remain, so any
  failure is directly actionable.

## [2.3.0] - 2026-06-23

### Added

- **Flexible identity remapping** — a mapping can change the **name only** (same
  email), the **email only**, or **both**, and several source identities can be
  **unified into one canonical** `Name <email>`. This lets a commit-counting
  webhook attribute a person correctly even when they committed under multiple
  usernames on the same email.
- **`--force-existing`** — opt in to apply new identities to branches that already
  exist on the destination. Because changing a name/email rewrites history (new
  SHAs), this is a force-update by definition; Vector warns that SHAs change and
  never force-pushes existing branches without it.

### Changed

- **Per-mapping safety check.** The post-rewrite validation now verifies exactly
  what each mapping intended: a name-only remap asserts the old name is gone *for
  that email* (the email is intentionally kept) instead of demanding the email
  disappear; an email change still asserts the old email is gone. It no longer
  false-fails on name-only/unify remaps, nor because a new/canonical identity
  legitimately already exists.
- **Idempotent/incremental push to an existing destination.** Branches absent on
  the destination are pushed, identical ones are skipped (no re-push), and
  present-but-different ones are skipped by default and reported — with a summary
  like `Pushed: 3 new · Skipped (already present): 1 (master) · Differs (use
  --force-existing): 0`. The deterministic rewrite (author+committer dates
  preserved) makes identical re-runs a true no-op.

## [2.2.1] - 2026-06-22

### Changed

- Docs: add **from-scratch (step by step)** guides for Windows, macOS, and Linux
  — install Node/Git/git-filter-repo, create and register an SSH key with GitHub
  and Azure DevOps, verify SSH, and run Vector — each pointing to
  `npx vector-migrate@latest --doctor` for troubleshooting. Also adds a CI matrix
  that runs the test suite on Ubuntu and macOS (Node 18 and 20). No code changes.

## [2.2.0] - 2026-06-22

### Added

- **`vector-migrate --doctor`** — an environment diagnostic that runs every
  prerequisite check and prints a `[✓]/[✗]` PASS/FAIL report with a one-line fix
  for each failure, changing nothing. It checks: `git`, `git-filter-repo`, the
  `ssh` client, the SSH keys in `~/.ssh` (listing them all), GitHub SSH
  authentication (tries every key; on failure lists each key, the OS-correct
  print command, and `https://github.com/settings/keys`), `github.com` in
  `known_hosts`, `fsutil` on Windows, and write access to the current directory.
  Exits non-zero if any check fails (CI-friendly), and uses ASCII marks on
  Windows for cmd code-page safety — so a user can prove whether a failure is
  their environment or Vector.

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

[2.3.1]: https://github.com/YRACHEK101/Vector/releases/tag/v2.3.1
[2.3.0]: https://github.com/YRACHEK101/Vector/releases/tag/v2.3.0
[2.2.1]: https://github.com/YRACHEK101/Vector/releases/tag/v2.2.1
[2.2.0]: https://github.com/YRACHEK101/Vector/releases/tag/v2.2.0
[2.1.1]: https://github.com/YRACHEK101/Vector/releases/tag/v2.1.1
[2.1.0]: https://github.com/YRACHEK101/Vector/releases/tag/v2.1.0
[2.0.0]: https://github.com/YRACHEK101/Vector/releases/tag/v2.0.0
