# Changelog

All notable changes to `vector-migrate` are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.6.0] - 2026-06-29

### Added

- **Auto-skip identity rewriting when you're not a contributor.** Migrating a repo you never committed to no longer dead-ends on the forced "Which detected author is YOU?" prompt (where every choice was wrong).
  - **Unified auto-match** (`matchYou`, one testable function) tries several signals, case-insensitively, in priority order: the **new verified email** you entered, the **name** you entered, your local `git config user.email`/`user.name`, and your authenticated **GitHub username** — email first, then name. A confident match is selected automatically with a short confirmation and **no prompt** (the existing "matches your git config" behaviour is unchanged).
  - **When no author matches you:** interactive runs now always offer an explicit final option — `❮ None of these — I didn't contribute to this repo (skip identity rewriting) ❯` — and non-interactive / `--force` / CI runs **auto-skip** with a clear warning (`No detected author matches you — skipping identity rewrite, all authors kept unchanged`) instead of erroring.
  - **Skipping = a plain mirror:** all author/committer identities are pushed **unchanged**; the identity `git-filter-repo` pass is not run. Everyone's commits stay attributed to them.
  - **`--me <email-or-name>`** — declare up front which detected author is you, bypassing the match. A value that matches no author warns and falls back to skip (`--force`) or the prompt (interactive).
  - **`--skip-identity`** (alias **`--no-identity`**, env `SKIP_IDENTITY`) — skip identity rewriting outright; never prompt, mirror with every author kept.

### Notes

- It is impossible to rewrite an author's commits into your identity unless you were actually matched or explicitly chose that author — the "picked the wrong person by accident" failure mode is eliminated.
- The existing happy path (you are a contributor and are auto-matched or select yourself) is unchanged.

## [2.5.0] - 2026-06-29

### Added

- **Automatic handling of GitHub's 100 MB file-size limit.** GitHub hard-rejects any single file larger than 100 MB found *anywhere* in history — and it does so at the very last step (the push), after the expensive mirror + identity rewrite are already done. Vector now catches this **before** the push:
  - **Pre-flight scan.** Once the staging copy is built (and before any `git push`), Vector streams the full object graph (`git rev-list --objects --all | git cat-file --batch-check` — nothing is checked out) and reports every offender with its path and human-readable size, e.g. `Found 1 file exceeding GitHub's 100 MB limit: Cursor-1.0.0-x86_64.AppImage (182.19 MB)`.
  - **`--max-file-size <MB>`** — the threshold (**default 100**, GitHub's limit). The byte threshold is derived from this single value (MiB-based, matching GitHub's display and `git-filter-repo`).
  - **`--on-large-file <strip|lfs|abort|prompt>`** — what to do with offenders. **Interactive** runs default to `prompt`; **non-interactive / `--force` / CI** runs default to **`strip`** with a loud warning, so a `--force` migration "just fixes it and pushes" with no manual steps. `abort` preserves the old fail-fast behaviour.
  - **`strip`** removes the offending blobs from *all* history via `git-filter-repo --strip-blobs-bigger-than`. When an identity rewrite is also running, the strip is **folded into the same filter-repo pass** (one rewrite, not two); in mirror mode it runs as a single targeted pass.
  - **`lfs`** moves the oversized paths to **Git LFS** (`git lfs migrate import`). If `git-lfs` isn't installed, Vector prints install steps and falls back to `strip` (auto/`--force`) or aborts (interactive).
  - **`GH001` fallback (belt & suspenders).** If a push is *still* rejected for size, Vector translates the raw `git push exited with code 1` into a plain-language message naming the remediation flags, instead of surfacing the bare exit code.
  - **Honest logging.** Whenever history is rewritten to remove/move files, Vector warns that those files are gone from the pushed history, that commit SHAs changed, and that existing clones must be re-cloned — and suggests a matching `.gitignore` line (e.g. `*.AppImage`) so the binary doesn't return on the next migration.

### Notes

- A repo with **no** oversized files is unaffected — the scan is fast and silent, with no new prompts and no behaviour change.
- Stripping/LFS-migrating **rewrites history, so commit SHAs change** by design. Re-running the migration from the Azure source re-introduces the blob (it still lives in Azure's history), so the fix lives in the rewrite/push stage and is re-applied on every run.

## [2.4.0] - 2026-06-26

### Added

- **Three routing modes**, chosen from a one-screen interactive menu or `--mode a|b|c`:
  - **A** — Azure DevOps ➔ GitHub with identity/email rewriting.
  - **B** — Azure DevOps ➔ GitHub, **mirror only** (a fast, verbatim bare-mirror copy — bypasses `git-filter-repo` entirely).
  - **C** — **GitHub ➔ GitHub** with identity rewriting; the source URL may be HTTPS **or** SSH (normalized internally).
- **0-commit auto-fallback.** A rewrite mode whose mapping matches **0 commits** automatically downgrades to the verbatim mirror path and logs why — rewriting nothing would only churn SHAs.
- **Zero-miss integrity engine** (`src/integrity.js`). After every push, Vector compares the migrated mirror against the destination across the **full ref set (branches + tags), each ref-tip OID, and the reachable commit count**, and aborts with a precise report (**exit 4**) on any mismatch. Tags now migrate alongside branches.
- **`--sync`** — incremental, fast-forward-only sync onto an existing target; a true ancestry **divergence stops with exit code 5** (never a silent clobber, never a crash). Mirror semantics use `--force-with-lease`, never a bare `--force`.
- **`--dry-run`** — plan and rewrite locally, report the push plan, perform **no remote writes**.
- **`--source`/`--dest`** aliases, **`--work-dir`** (staging now defaults to `./.vector-staging`), **`--json`** machine-readable output, and **`-v/--verbose`**.
- **Documented exit codes**: `0` ok · `2` bad input · `3` git failure · `4` integrity mismatch · `5` divergence.

### Changed

- The interactive flow now starts with the mode menu, then prompts only for what's missing.
- Staging artifacts live under one work dir (`./.vector-staging`) instead of the current directory.
- All legacy flags/env (`--azure-url`/`AZURE_URL`, `--github-ssh`/`GITHUB_SSH`, the `--old-email`/`--new-*` trio, `--mailmap`, `--map`, `--branch`, `--force`, `--force-existing`, `--non-interactive`, `--check`) remain fully supported.

### Notes

- Email rewriting **changes commit SHAs by design** (a SHA includes the author/committer identity). Vector's rewrite is **deterministic** — identical input + mapping yields byte-identical output SHAs — so re-syncs only ever fast-forward the destination and never force-rewrite already-pushed history. A `.mailmap` is display-only and is not honored by GitHub for attribution; Vector rewrites the actual commit emails.

## [2.3.2] - 2026-06-23

### Fixed

- **Branches whose directory differs only by case no longer strand un-rewritten
  commits.** When a repo had sibling branches under directories that differ only
  in case — e.g. `yRachek/Front-end` and `yRachek/connect_erp` alongside
  `yrachek/E2E-test` — the rewrite silently broke on case-insensitive filesystems
  (macOS, Windows): git folds `yRachek/` and `yrachek/` into one directory, so the
  clone/rewrite re-cased one branch while the original stayed in `packed-refs`,
  leaving its **original (un-rewritten) commits reachable**. The migration then
  aborted at the post-rewrite safety check ("old email … still present"). Vector
  now detects this **directory-case conflict** (previously only whole-name
  case-only and directory/file collisions were caught) and resolves it by
  re-casing the stray segment to a single canonical spelling — preserving every
  branch and every commit. A `-N` suffix is deliberately *not* used here: it can
  never remove a colliding directory prefix.
- The case-respelling rename is applied **old-ref-first** (delete then re-create),
  because the two spellings alias each other on a case-insensitive filesystem and
  a create-first order would let the delete remove the freshly-written ref.

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
