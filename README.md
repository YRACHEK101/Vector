<p align="center">
  <img src="assets/vector-logo.svg" alt="Vector logo" width="120" height="120" />
</p>

<h1 align="center">Vector</h1>

<p align="center">
  <strong><code>vector-migrate</code></strong> — move your repos from Azure DevOps to GitHub without losing your green squares.
</p>

<p align="center"><em>Interactive · Zero-Token · Non-Destructive</em></p>

<p align="center">
  <a href="https://www.npmjs.com/package/vector-migrate"><img src="https://img.shields.io/npm/v/vector-migrate?color=cb3837&logo=npm" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/vector-migrate"><img src="https://img.shields.io/npm/dm/vector-migrate?color=cb3837&logo=npm" alt="npm downloads" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/vector-migrate?logo=node.js&logoColor=white" alt="node version" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/vector-migrate?color=blue" alt="MIT license" /></a>
</p>

<p align="center">
  📦 <strong>Available on npm:</strong> <a href="https://www.npmjs.com/package/vector-migrate">npmjs.com/package/vector-migrate</a>
</p>

```bash
npx vector-migrate          # run the interactive wizard — no install required
```

---

## What is Vector?

Vector (`vector-migrate`) is an **interactive, zero-token** NPM command-line utility that bridges your Git repositories from **Azure DevOps** to **GitHub** seamlessly.

It preserves your complete commit history and re-attributes your authorship — restoring your contribution graph — via a deterministic `git-filter-repo` rewrite and a hang-proof SSH push. No Personal Access Tokens to leak, no script to edit.

---

## The Real-World Problem It Solves

Moving from a closed enterprise ecosystem (Azure DevOps) to a public one (GitHub) looks like a one-line `git push` — until it quietly costs you your credit, your credentials, or an afternoon staring at a frozen terminal. Vector is built to kill three very specific pains:

### The Contribution Graph Wipeout

Inside a company you commit with a corporate work email (`you@bigcorp.com`). GitHub only lights up your contribution graph for commits whose author email is **verified on your account** — so a standard migration carries every one of those commits over as an unattributed "ghost." Months or years of real work simply never show up as green squares.

Vector rewrites **only your old corporate identity** to your personal, verified identity — leaving teammates' commits untouched — so your history counts again, at its original dates.

### The Security Token Leak

The quick-and-dirty way to authenticate a migration is to paste a Personal Access Token (PAT) directly into the clone URL or a config file. That token then bleeds into your shell history, your `.git/config`, and CI logs — a credential time-bomb that's trivially exfiltrated.

Vector is **zero-token by design**: it authenticates over SSH keys only, and reads configuration from safe local environment variables or interactive in-memory prompts that are never written to disk. There is simply no secret to hardcode, log, or accidentally commit.

### The HTTPS Push Freeze

Pushing a large history over HTTPS routinely hangs at `Writing objects: 100%` on macOS and Linux — the client stalls waiting on a server acknowledgment stuck behind buffer limits.

Vector eliminates the bottleneck by streaming over a **single persistent raw-SSH pipeline**, so even large repositories transfer reliably and predictably.

---

## Quick Start

```bash
# 1. Install the one system dependency (see OS table below)
brew install git-filter-repo          # macOS example

# 2. Run the wizard — it walks you through everything
npx vector-migrate
```

That's it. The interactive wizard prompts for your Azure source, GitHub destination, and identity details, then does the rest.

---

## Installation & Usage

Vector needs **Node.js ≥ 18** plus two git tools (`git` and `git-filter-repo` — see [Prerequisites](#prerequisites-git-filter-repo)).

**Run with no install:**

```bash
npx vector-migrate
```

**Global install (recommended for repeat use):**

```bash
npm install -g vector-migrate
vector-migrate
```

Once installed, the command is available anywhere:

```bash
vector-migrate                 # interactive, colored wizard
vector-migrate --check         # preflight: validate tools + config, change nothing
vector-migrate --help          # full flag reference
```

> **Tip:** Run `vector-migrate --check` first — it verifies that `git` and `git-filter-repo` are installed and prints exact, OS-specific install instructions if anything is missing.

---

## Non-Interactive / Scripted Runs

Every prompt has a flag **and** an environment variable. Provide them up front to skip the wizard entirely — ideal for CI.

**Using flags:**

```bash
vector-migrate --non-interactive \
  --azure-url  "https://org@dev.azure.com/org/Project/_git/Repo" \
  --github-ssh "git@github.com:your-user/your-repo.git" \
  --old-email  "you@old-corp.com" \
  --new-name   "your-github-username" \
  --new-email  "you@personal.com" \
  --branch master --branch main          # ← repeat the flag to sync multiple branches
```

**Using environment variables:**

```bash
export AZURE_URL="https://org@dev.azure.com/org/Project/_git/Repo"
export GITHUB_SSH="git@github.com:your-user/your-repo.git"
export OLD_EMAIL="you@old-corp.com"
export NEW_NAME="your-github-username"
export NEW_EMAIL="you@personal.com"
export PUSH_BRANCHES="master main"

vector-migrate --non-interactive
```

### Flag & Environment Variable Reference

| Flag | Env var | Meaning |
| --- | --- | --- |
| `--azure-url` | `AZURE_URL` | Source Azure DevOps clone URL |
| `--github-ssh` | `GITHUB_SSH` | Destination GitHub repo (SSH form) |
| `--old-email` | `OLD_EMAIL` | Old corporate email in your commits |
| `--extra-old-emails` | `EXTRA_OLD_EMAILS` | More old emails of yours (comma-separated) |
| `--new-name` | `NEW_NAME` | New author name / GitHub username |
| `--new-email` | `NEW_EMAIL` | New GitHub-verified email |
| `--project` | `PROJECT` | Local folder slug (auto-derived) |
| `--branch` / `--branches` | `PUSH_BRANCHES` | Branch(es) to sync (default `["master", "main"]`) |
| `--ssh-key` | `SSH_KEY` | Private key for the SSH push |
| `--force` | — | Allow force-push **only** on a true divergence |
| `--check` | — | Validate tools + config, then exit |

---

## Prerequisites: `git-filter-repo`

Vector's one system dependency is `git-filter-repo` (it also needs `git`, which you almost certainly already have). Install it for your OS:

| OS | Install command |
| --- | --- |
| **macOS** | `brew install git-filter-repo` |
| **Linux (Ubuntu/Debian)** | `sudo apt install git-filter-repo` |
| **Windows** | `pip install git-filter-repo` (via Python) — run Vector in Git Bash or WSL |

### macOS

```bash
brew install git-filter-repo
npx vector-migrate
```

### Linux (Ubuntu / Debian)

```bash
sudo apt update && sudo apt install -y git git-filter-repo

# ── or, on any distro, via pip ──
pip3 install --user git-filter-repo

npx vector-migrate
```

### Windows

`git-filter-repo` is a Python program, so install Python first, then the tool, then run Vector through a Bash-capable shell.

**Git Bash** (ships with Git for Windows):

```bash
pip install git-filter-repo      # requires Python on PATH
npx vector-migrate
```

**WSL** (Windows Subsystem for Linux) — treat it exactly like Linux (recommended for large repos):

```bash
sudo apt install -y git git-filter-repo   # or: pip3 install --user git-filter-repo
npx vector-migrate
```

**Native Windows / PowerShell** — make sure Python + `pip install git-filter-repo` are on your `PATH` so `git filter-repo` is callable, then run Node normally:

```powershell
pip install git-filter-repo
npx vector-migrate
```

---

## Requirements: GitHub SSH access

Vector pushes to GitHub over **SSH** (it never touches Personal Access Tokens), so you need an SSH key registered on your GitHub account before migrating. If a key isn't set up, the mirror and rewrite still run but the final push fails with `Permission denied (publickey)` — so Vector checks this up front and stops early with guidance.

Set it up once:

```bash
ssh-keygen -t ed25519 -C "you@example.com"      # press Enter for the defaults
# Add the public key to GitHub → Settings → SSH and GPG keys → New SSH key:
cat ~/.ssh/id_ed25519.pub
ssh -T git@github.com                            # should greet you by username
```

> A successful `ssh -T git@github.com` prints `Hi <user>! You've successfully authenticated…` **and exits with code 1** — that's normal for GitHub. Vector detects success by the message, not the exit code.

Run `vector-migrate --check` to verify everything at once — it reports whether `git` and `git-filter-repo` are installed **and** whether your GitHub SSH access works (printing these exact setup steps if it doesn't). It changes nothing.

---

## Incremental Syncs (re-running safely)

Migration is rarely one-and-done. Re-run Vector any time new commits land on Azure — it's incremental and strictly **non-destructive**:

- **Fetches only the new commits** into a pristine local mirror (never re-cloning, never corrupting it).
- **Re-applies the identity rewrite deterministically**, so commits already on GitHub keep the exact same SHAs.
- **Fast-forwards just the delta** onto GitHub — existing history is left byte-for-byte intact.
- **Never overwrites GitHub.** If the remote is ahead or has genuinely diverged, Vector stops instead of clobbering — it only force-pushes a true divergence with an explicit `--force`.

---

## How It Works

```text
  Azure DevOps                         (local)                         GitHub
  ┌──────────┐  1. mirror/fetch  ┌──────────────┐  3. SSH push  ┌──────────┐
  │  source  │ ───────────────▶  │ <slug>-      │ ────────────▶ │  target  │
  │   repo   │   (full history)  │ source.git   │  (per branch, │   repo   │
  └──────────┘                   └──────┬───────┘   ancestry-    └──────────┘
                                        │            aware)
                       2. rebuild + git-filter-repo --mailmap
                          ┌──────────────┐
                          │ <slug>-      │   deterministic rewrite:
                          │ migration.git│   old email → new identity
                          └──────────────┘   (teammates untouched)
```

A pristine **source mirror** is the only thing fetched into; a disposable **staging copy** is rebuilt and rewritten each run; the **push is ancestry-aware** (create / no-op / fast-forward / skip-if-ahead / confirm-on-divergence).

---

## Testing & Quality

Vector ships with a rigorous, fully-offline test suite (Node's built-in runner — no test-framework dependency):

```bash
npm test
```

It covers configuration parsing & validation, programmatic dependency checks (with human-readable errors), the pure push-decision logic, and a full incremental-sync integration test that runs the real pipeline against local stand-in repositories — asserting idempotency, deterministic SHAs, delta-only rewriting, and non-destructive pushes.

A pure-Bash implementation (`migrate.sh`, with `tests/run_tests.sh`) is also included for environments without Node.

---

## Contributing

Contributions are welcome!

1. **Open an issue** describing the change and your environment (`node -v`, `git --version`, `git filter-repo --version`).
2. **Fork and branch** from `main` (`feat/…` or `fix/…`).
3. **Keep the core modules** (`src/config.js`, `src/pipeline.js`, `src/prereqs.js`) dependency-free and add tests under `tests/`.
4. **Run `npm test`** and open a focused Pull Request using [Conventional Commits](https://www.conventionalcommits.org/).

---

## License

Released under the **MIT License** — see [`LICENSE`](LICENSE).