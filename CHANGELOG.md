# Changelog

All notable changes to `vector-migrate` are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[2.0.0]: https://github.com/YRACHEK101/Vector/releases/tag/v2.0.0
