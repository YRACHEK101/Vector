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
npx vector-migrate@latest          # run the interactive wizard — no install required
```

---

## What is Vector?

Vector (`vector-migrate`) is an **interactive, zero-token** NPM command-line utility that moves your Git repositories to **GitHub** — from **Azure DevOps** or from **another GitHub repo** — seamlessly.

It preserves your complete commit history and re-attributes your authorship — restoring your contribution graph — via a deterministic `git-filter-repo` rewrite and a hang-proof SSH push. No Personal Access Tokens to leak, no script to edit.

It offers **three routing modes** (Azure→GitHub with rewriting, Azure→GitHub mirror-only, and GitHub→GitHub with rewriting), a **0-commit auto-fallback** to a verbatim mirror when there's nothing to rewrite, and a **zero-miss integrity engine** that verifies every branch + tag tip and the commit count after each push. See [Migration modes](#migration-modes).

---

## The Real-World Problem It Solves

Moving from a closed enterprise ecosystem (Azure DevOps) to a public one (GitHub) looks like a one-line `git push` — until it quietly costs you your credit, your credentials, or an afternoon staring at a frozen terminal. Vector is built to kill three very specific pains:

### The Contribution Graph Wipeout

Inside a company you commit with a corporate work email (`you@bigcorp.com`). GitHub only lights up your contribution graph for commits whose author email is **verified on your account** — so a standard migration carries every one of those commits over as an unattributed "ghost." Months or years of real work simply never show up as green squares.

By default, Vector rewrites **your** old corporate identity to your personal, verified one and leaves everyone else untouched — so your history counts again, at its original dates. Migrating a shared repo? The same flow can remap **multiple contributors across every branch**, so your whole team keeps attribution (see [Solo and team migration](#solo-and-team-migration)).

### The Security Token Leak

The quick-and-dirty way to authenticate a migration is to paste a Personal Access Token (PAT) directly into the clone URL or a config file. That token then bleeds into your shell history, your `.git/config`, and CI logs — a credential time-bomb that's trivially exfiltrated.

Vector is **zero-token by design**: it authenticates over SSH keys only, and reads configuration from safe local environment variables or interactive in-memory prompts that are never written to disk. There is simply no secret to hardcode, log, or accidentally commit.

### The HTTPS Push Freeze

Pushing a large history over HTTPS routinely hangs at `Writing objects: 100%` on macOS and Linux — the client stalls waiting on a server acknowledgment stuck behind buffer limits.

Vector eliminates the bottleneck by streaming over a **single persistent raw-SSH pipeline**, so even large repositories transfer reliably and predictably.

---

## Quick Start

```bash
# 1. Install the one system dependency for your OS:
brew install git-filter-repo                 # macOS
sudo apt install -y git-filter-repo          # Linux (Debian/Ubuntu) — or: pip3 install --user git-filter-repo
pip install git-filter-repo                  # Windows (needs Python; run in Git Bash or WSL)

# 2. Run the wizard — it walks you through everything
npx vector-migrate@latest
```

That's it. The interactive wizard first asks **which kind of migration** you want, then prompts only for what's missing (source, destination, and — for rewrite modes — your identity), then does the rest. See [Prerequisites: git-filter-repo](#prerequisites-git-filter-repo) for per-OS detail.

---

## Migration modes

On startup (when you don't pass `--mode`) Vector shows a one-screen menu:

| Mode | Route | Identity rewrite? | Non-interactive |
|------|-------|-------------------|-----------------|
| **A** 🟦 | Azure DevOps ➔ GitHub | **Yes** — rewrites author/committer emails so GitHub attributes commits to you | `--mode a` |
| **B** 🟩 | Azure DevOps ➔ GitHub | **No** — a fast, verbatim bare-mirror copy | `--mode b` |
| **C** 🟪 | GitHub ➔ GitHub | **Yes** — same deterministic rewrite; source URL may be HTTPS **or** SSH | `--mode c` |

Each menu choice maps 1:1 to `--mode a|b|c`, so scripted/CI runs never need a TTY.

- **0-commit auto-fallback.** If you choose a rewrite mode (A/C) but the old email matches **0 commits** in the history, Vector automatically downgrades to the mirror path (Mode B) and tells you why — rewriting nothing would only churn SHAs for no benefit.
- **Why rewriting changes SHAs (by design).** A commit's SHA is derived from its content *including* the author/committer identity, so changing an email necessarily produces new SHAs. Vector's rewrite is **deterministic**: the same input history + mapping yields byte-identical output SHAs every run, so re-syncs only ever **fast-forward** the destination — they never force-rewrite already-pushed history. (A `.mailmap` alone is display-only and is *not* honored by GitHub for attribution — Vector rewrites the actual commit emails.)

```bash
# Mode A — Azure ➔ GitHub with rewrite (non-interactive)
vector-migrate --mode a \
  --source "https://org@dev.azure.com/org/proj/_git/repo" \
  --dest   "git@github.com:you/repo.git" \
  --old-email old@corp.com --new-name you --new-email you@users.noreply.github.com --yes

# Mode B — Azure ➔ GitHub, verbatim mirror (no rewrite)
vector-migrate --mode b --source "<azure-url>" --dest "git@github.com:you/repo.git" --yes

# Mode C — GitHub ➔ GitHub with rewrite (HTTPS or SSH source)
vector-migrate --mode c --source "https://github.com/old-org/repo" --dest "git@github.com:you/repo.git" \
  --old-email old@corp.com --new-email you@users.noreply.github.com --yes
```

---

## Installation & Usage

Vector needs **Node.js ≥ 18** plus two git tools (`git` and `git-filter-repo` — see [Prerequisites](#prerequisites-git-filter-repo)).

**Run with no install:**

```bash
npx vector-migrate@latest
```

**Global install (recommended for repeat use):**

```bash
npm install -g vector-migrate
vector-migrate
```

Once installed, the command is available anywhere:

```bash
vector-migrate                 # interactive, colored wizard
vector-migrate --check         # preflight: validate tools, config + GitHub SSH; changes nothing
vector-migrate --help          # full flag reference
```

> **Tip:** Run `vector-migrate --check` first — it verifies that `git` and `git-filter-repo` are installed **and that your GitHub SSH access works**, and prints exact, OS-specific setup instructions if anything is missing.

---

## From scratch (step by step)

Never set this up before? These guides take you from zero to a working migration on your operating system.

### Windows — from scratch (step by step)

New to this on Windows? Here is everything from zero. Run the commands in **Command Prompt**.

**1. Install Node.js.** Download the LTS build from nodejs.org and install it. Verify: `node -v` and `npm -v`.

**2. Install Git.** Download Git for Windows from git-scm.com and install with the defaults. Verify: `git --version`.

**3. Install git-filter-repo.** Vector needs it. Run `pip install git-filter-repo`. If `pip` isn't found, install Python from python.org (check "Add Python to PATH"), then retry. Verify: `git filter-repo --version`.

**4. Create an SSH key.** Run `ssh-keygen -t ed25519 -C "your-email@example.com"` and press Enter at every prompt for the defaults.

**5. Register the key with GitHub.** Print it with `type %USERPROFILE%\.ssh\id_ed25519.pub`, copy the whole line (it starts with `ssh-ed25519`), then go to https://github.com/settings/keys → New SSH key → paste → Add SSH key.

**6. Register the same key with Azure DevOps.** In Azure DevOps: avatar (top right) → User settings → SSH public keys → New Key → paste the same key → Save.

**7. Verify SSH works.** Run `ssh -T git@github.com`. You should see `Hi <username>! You've successfully authenticated...`. If asked "continue connecting?", type `yes`.

**8. Run Vector.** `npx vector-migrate@latest`. Answer the prompts: Azure URL (HTTPS is easiest: `https://ORG@dev.azure.com/ORG/PROJECT/_git/REPO`), GitHub destination (`git@github.com:USERNAME/REPO.git`), and a short project slug.

**Notes**
- The key must be registered on **both** GitHub (for the push) and Azure (for the fetch); missing either side will fail.
- Steps 1–7 are one-time setup. After that, each migration is just step 8.
- Azure over HTTPS is usually easier than SSH — if Azure SSH gives you trouble, use the HTTPS URL.
- If anything goes wrong, run `npx vector-migrate@latest --doctor` to see exactly what's missing.

### macOS — from scratch (step by step)

New to this on macOS? Everything from zero. Run the commands in **Terminal**.

**1. Install Node.js.** Download the LTS build from nodejs.org, or `brew install node`. Verify: `node -v` and `npm -v`.

**2. Install Git.** Often preinstalled. If not: `xcode-select --install` or `brew install git`. Verify: `git --version`.

**3. Install git-filter-repo.** `brew install git-filter-repo` (or `pip3 install git-filter-repo`). Verify: `git filter-repo --version`.

**4. Create an SSH key.** `ssh-keygen -t ed25519 -C "your-email@example.com"` — press Enter at every prompt for the defaults.

**5. Register the key with GitHub.** Copy it: `pbcopy < ~/.ssh/id_ed25519.pub` (or `cat ~/.ssh/id_ed25519.pub` and copy the line manually). Go to https://github.com/settings/keys → New SSH key → paste → Add SSH key.

**6. Register the same key with Azure DevOps.** Avatar (top right) → User settings → SSH public keys → New Key → paste the same key → Save.

**7. Verify SSH works.** `ssh -T git@github.com` → `Hi <username>! You've successfully authenticated...`. If asked "continue connecting?", type `yes`.

**8. Run Vector.** `npx vector-migrate@latest`. Answer the prompts: Azure URL (HTTPS is easiest: `https://ORG@dev.azure.com/ORG/PROJECT/_git/REPO`), GitHub destination (`git@github.com:USERNAME/REPO.git`), and a short project slug.

### Linux — from scratch (step by step)

New to this on Linux? Everything from zero. Commands shown for the common distros.

**1. Install Node.js.** Easiest is nvm: `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash` then `nvm install --lts`. Or per distro — Debian/Ubuntu (NodeSource), Fedora `sudo dnf install nodejs`, Arch `sudo pacman -S nodejs npm`. Verify: `node -v` and `npm -v`.

**2. Install Git.** Debian/Ubuntu `sudo apt install git`; Fedora `sudo dnf install git`; Arch `sudo pacman -S git`. Verify: `git --version`.

**3. Install git-filter-repo.** `pip3 install git-filter-repo`, or Debian/Ubuntu `sudo apt install git-filter-repo`, Fedora `sudo dnf install git-filter-repo`. Verify: `git filter-repo --version`.

**4. Create an SSH key.** `ssh-keygen -t ed25519 -C "your-email@example.com"` — press Enter at every prompt.

**5. Register the key with GitHub.** Show it: `cat ~/.ssh/id_ed25519.pub` (or copy with `xclip -sel clip < ~/.ssh/id_ed25519.pub`), then go to https://github.com/settings/keys → New SSH key → paste → Add SSH key.

**6. Register the same key with Azure DevOps.** Avatar (top right) → User settings → SSH public keys → New Key → paste the same key → Save.

**7. Verify SSH works.** `ssh -T git@github.com` → `Hi <username>! You've successfully authenticated...`. If asked, type `yes`.

**8. Run Vector.** `npx vector-migrate@latest`. Answer the prompts (Azure URL — HTTPS easiest, GitHub destination, short slug).

**Notes (macOS & Linux)**
- The key must be registered on **both** GitHub (for the push) and Azure (for the fetch); missing either side will fail.
- Steps 1–7 are one-time setup. After that, each migration is just step 8.
- Azure over HTTPS is usually easier than SSH — if Azure SSH gives trouble, use the HTTPS URL.
- If anything goes wrong, run `npx vector-migrate@latest --doctor` to see exactly what's missing.

## Solo and team migration

Vector has **one auto-detecting flow** — there is no mode to choose. After it mirrors the Azure repo, it scans every author across all branches and shows you who's there:

- **Solo (the default).** Vector maps **you** — matched to your git identity, or picked from the detected list — to your new verified identity and **keeps everyone else unchanged**. Your green squares come back; teammates' commits stay theirs.
- **Team.** At the mapping step you can also remap **additional contributors** — each to a new name/email, or skip them to keep their old identity. Every mapped developer keeps attribution, at original dates.

Solo is just this flow with a single mapping; team is the same flow with more. By **default every branch** is migrated (`--all-branches` is the default — use `--branch` to narrow to specific ones).

For CI, supply the full mapping up front instead of answering prompts — a version-controlled mailmap file, or repeatable inline maps:

```bash
# A mailmap file (one line per developer) — best for CI:
vector-migrate --non-interactive \
  --azure-url  "https://org@dev.azure.com/org/Project/_git/Repo" \
  --github-ssh "git@github.com:acme/repo.git" \
  --mailmap ./team.mailmap --all-branches

# …or inline, repeatable:
vector-migrate --non-interactive \
  --azure-url "…" --github-ssh "git@github.com:acme/repo.git" \
  --map "alice@oldcorp.com=Alice New <alice@newco.com>" \
  --map "bob@oldcorp.com=Bob New <bob@newco.com>"
```

`team.mailmap` uses git's standard mailmap format:

```
Alice New <alice@newco.com> <alice@oldcorp.com>
Bob New <bob@newco.com> <bob@oldcorp.com>
```

### Remapping: name-only, email-only, or unify many into one

A mapping can change the **name only**, the **email only**, or **both** — and several source identities can be **unified into one canonical** `Name <email>`:

```
# Name only (email kept) — normalizes EVERY commit with this email to one name.
# Use this to unify a person who committed under several usernames:
#   YRACHEK101 <yrachek@liadtech.com>, Y. Rachek <…>, yRachek <…>  →  YRACHEK101 <…>
YRACHEK101 <yrachek@liadtech.com>

# Email only / both — map an old identity to a new name and verified email:
YRACHEK101 <yrachek@github.com> <yrachek@liadtech.com>

# Unify several different source identities into one canonical identity:
Canonical Name <canonical@company.com> Old Name <old1@corp.com>
Canonical Name <canonical@company.com> <old2@corp.com>
```

Vector validates **per mapping** exactly what each change intended: a name-only remap only requires the **old name to be gone for that email** (the email is kept on purpose); an email change requires the **old email to be gone**. It never errors just because the new/canonical identity already legitimately exists in history. This is what makes a commit-counting webhook attribute a person correctly even when they committed under several usernames.

**In the interactive flow you don't hunt names down one by one.** When you enter your new NAME and EMAIL, Vector automatically unifies **every** author name it finds under your email — both your source email and your new email (in case you already committed under that email with a different display name) — to your chosen identity. The detected "you" identity is included even if its name differs. Other authors are grouped by email and **kept unchanged** unless you explicitly remap them. So providing one NAME + EMAIL is all it takes to collapse `Y. Rachek <…>`, `Yahia RACHEK <…>`, `yRachek <…>` into one contributor.

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
| `--mode <a\|b\|c>` | `MODE` | Migration mode (skips the menu): A/C rewrite identities, B mirrors verbatim. [Modes](#migration-modes) |
| `--source <url>` | `SOURCE` | Source repo (Azure or GitHub; HTTPS or SSH). Alias of `--azure-url` |
| `--dest <url>` | `DEST` | Destination GitHub repo (SSH recommended). Alias of `--github-ssh` |
| `--azure-url` | `AZURE_URL` | Source repo URL (legacy alias of `--source`) |
| `--github-ssh` | `GITHUB_SSH` | Destination GitHub repo (legacy alias of `--dest`) |
| `--ssh-key` | `SSH_KEY` | Private key for the SSH push |
| `--mailmap <path>` | `MAILMAP` | git mailmap file — full multi-author mapping (ideal for CI) |
| `--map "old=New <new>"` | `MAPS` | Inline identity mapping; **repeatable** |
| `--old-email` | `OLD_EMAIL` | Legacy single-identity: your old corporate email… |
| `--new-name` | `NEW_NAME` | …mapped to this author name |
| `--new-email` | `NEW_EMAIL` | …and this verified GitHub email |
| `--extra-old-emails` | `EXTRA_OLD_EMAILS` | More old emails of yours (comma-separated) |
| `--branch <name>` | `PUSH_BRANCHES` | Limit to specific branch(es); **repeatable** (also `--branches "a,b"`). Narrowing **skips tags**. **Default: all branches + tags** |
| `--all-branches` | `ALL_BRANCHES` | Migrate every branch (the default) |
| `--sync` | `SYNC` | Incremental sync onto an existing target: fast-forward only; **prompts/stops on a true divergence** |
| `--dry-run` | — | Plan + rewrite locally, report the push plan, perform **no remote writes** |
| `--force` | — | Allow force-push **only** on a true divergence |
| `--force-existing` | — | Apply new identities to branches **already on the destination** (force-update — commit SHAs change for those branches) |
| `--work-dir <path>` | `WORK_DIR` | Staging directory (default `./.vector-staging`) |
| `--json` | `JSON` | Machine-readable, one-JSON-object-per-line output (implies non-interactive) |
| `-v`, `--verbose` | — | Extra diagnostic output |
| `--non-interactive` | — | Skip all prompts (rewrite modes need a complete mapping; mirror modes don't) |
| `-y`, `--yes` | — | Assume "yes" at the confirm gate |
| `--check` | — | Validate tools, config **and GitHub SSH access**, then exit (no clone) |
| `--project` | `PROJECT` | Local folder slug (auto-derived) |

### Exit codes

Scripts can branch on the process exit code:

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `2` | Bad input / usage (unknown flag, invalid `--mode`, incomplete config) |
| `3` | git / subprocess failure |
| `4` | **Integrity mismatch** — the destination does not match the migrated history (see below) |
| `5` | **Divergence** — a `--sync` cannot fast-forward a branch; a human decision is needed |

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
npx vector-migrate@latest
```

### Linux (Ubuntu / Debian)

```bash
sudo apt update && sudo apt install -y git git-filter-repo

# ── or, on any distro, via pip ──
pip3 install --user git-filter-repo

npx vector-migrate@latest
```

### Windows

`git-filter-repo` is a Python program, so install Python first, then the tool, then run Vector through a Bash-capable shell.

**Git Bash** (ships with Git for Windows):

```bash
pip install git-filter-repo      # requires Python on PATH
npx vector-migrate@latest
```

**WSL** (Windows Subsystem for Linux) — treat it exactly like Linux (recommended for large repos):

```bash
sudo apt install -y git git-filter-repo   # or: pip3 install --user git-filter-repo
npx vector-migrate@latest
```

**Native Windows / PowerShell** — make sure Python + `pip install git-filter-repo` are on your `PATH` so `git filter-repo` is callable, then run Node normally:

```powershell
pip install git-filter-repo
npx vector-migrate@latest
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

## Windows

Vector runs natively on Windows. Always run it as **`npx vector-migrate@latest`** so you pick up the newest SSH and branch-conflict fixes — `npx` can otherwise reuse a cached older build. Two Windows-specific things are worth knowing.

### SSH key setup

Vector authenticates over SSH (never a token), so you need an SSH key registered with **both** Azure DevOps (the source) and GitHub (the destination). If no key is found, Vector stops **before** the long mirror clone and prints these exact steps — so you fix it in seconds instead of waiting and then failing.

```bat
:: 1. Generate a key (press Enter at every prompt for the defaults)
ssh-keygen -t rsa -b 4096 -C "your-email@gmail.com"

:: 2. Print the public key and copy it
type %USERPROFILE%\.ssh\id_rsa.pub
```

A modern alternative is `ssh-keygen -t ed25519 -C "your-email"`.

Then add that **public** key to both services:

- **Azure DevOps** — User settings → **SSH public keys** → New Key
- **GitHub** — Settings → **SSH and GPG keys** → New SSH key (direct link: `https://github.com/settings/keys`)

**Any of your keys can work.** Vector doesn't pin to one identity — the preflight offers your `ssh-agent` and **every** key in `~/.ssh` (`id_ed25519`, `id_rsa`, `id_ecdsa`, `id_dsa`) and passes as long as **one** of them is registered. If none is registered, it stops **before** the long mirror clone and the message **lists every local key** with the exact command to print it and a direct link to register one — so you register the right file and re-run. To force a specific key, pass `--ssh-key <path>`.

Vector trusts the `github.com` (and, for an SSH Azure source, `ssh.dev.azure.com`) host keys automatically, and verifies authentication up front. If your Azure source URL is **HTTPS**, no Azure SSH key is needed — Vector skips the Azure SSH checks entirely.

> Running in **Git Bash** or **WSL** instead of `cmd`? Use `cat ~/.ssh/id_rsa.pub` to print the key. WSL behaves exactly like Linux.

### Case-insensitive branch conflicts (handled automatically)

Windows (and default macOS) filesystems are case-insensitive, which makes git-filter-repo crash with `cannot lock ref 'refs/heads/X': 'refs/heads/x' exists` when a repo contains branches that collide once case is ignored — for example:

- two branches differing only in case: `Mbouzine` vs `MBouzine`
- a branch that is also a path-prefix of another: `MBouzine` and `MBouzine/init_repo`

**Vector now detects these before the rewrite and resolves them for you** — no crash, no manual cleanup. On Windows it first tries to enable case-sensitive ref storage for its scratch copy (via `fsutil`); for anything that remains it offers a choice, defaulting to the safe, data-preserving option:

1. **Rename** the conflicting branch(es) with a `-N` suffix so **every** branch still migrates (default).
2. **Skip** the conflicting branch(es) with a warning.
3. **Abort** with guidance (re-run on Linux/WSL, or narrow the set with `--branch`).

---

## Diagnose your environment

Not sure whether a problem is your machine or Vector? Run the built-in diagnostic. It checks everything and prints a PASS/FAIL report with the exact fix for any failing line, and it changes nothing.

On **Windows**, open **Command Prompt (Run as administrator)** and run:

```
npx vector-migrate@latest --doctor
```

(On macOS/Linux, run the same command in your terminal.)

`--doctor` verifies `git`, `git-filter-repo`, the `ssh` client, the SSH keys in your `~/.ssh`, and — crucially — whether one of your keys is actually **registered with GitHub**. Every line is marked `[✓]` or `[✗]`, and each `[✗]` prints exactly what to fix — on an SSH auth failure it lists each local key, the command to print it (`type %USERPROFILE%\.ssh\<name>.pub` on Windows, `cat ~/.ssh/<name>.pub` on macOS/Linux), and the registration link `https://github.com/settings/keys`. It exits non-zero if any check fails, so it is CI-friendly too.

Prefer a global install?

```
npm i -g vector-migrate@latest
vector-migrate --doctor
```

Always use `@latest`: `npx` can otherwise serve a cached older build and hide a fix you already have.

---

## Incremental Syncs (re-running safely)

Migration is rarely one-and-done. Re-run Vector any time new commits land on Azure — it's incremental and strictly **non-destructive**:

- **Fetches only the new commits** into a pristine local mirror (never re-cloning, never corrupting it).
- **Re-applies the identity rewrite deterministically**, so commits already on GitHub keep the exact same SHAs.
- **Fast-forwards just the delta** onto GitHub — existing history is left byte-for-byte intact.
- **Never overwrites GitHub.** If the remote is ahead or has genuinely diverged, Vector stops instead of clobbering — it only force-pushes a true divergence with an explicit `--force`.

### Re-running against an already-migrated repo

Vector is idempotent against an existing destination. Before pushing, it inspects the destination's refs and, per branch:

- **Not on the destination** → pushed.
- **Already present and identical** → skipped (no re-push).
- **Already present but different** → skipped by default and reported — never silently overwritten.

It prints a summary, e.g. `Pushed: 3 new · Skipped (already present): 1 (master) · Differs (use --force-existing): 0`. Because the rewrite is deterministic (author **and** committer dates preserved, stable mapping order), an identical re-run reproduces identical SHAs and is a true no-op — so you can safely "add the remaining branches" without touching the ones already pushed.

### Applying new identities to branches already pushed (`--force-existing`)

Changing an author's **name or email necessarily rewrites history** — those commits get **new SHAs** — so updating a branch that's already on the destination is, by definition, a **force-update**. Vector never does this implicitly. Pass `--force-existing` to opt in: branches that exist on the destination but differ because of the new mapping are force-pushed, after a warning that their commit SHAs will change. Branches not yet on the destination are still pushed normally; identical ones are still skipped.

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

A pristine **source mirror** is the only thing fetched into; a disposable **staging copy** is rebuilt and rewritten each run; the **push is ancestry-aware** (create / no-op / fast-forward / skip-if-ahead / confirm-on-divergence). For a verbatim **Mode B** mirror (or the 0-commit auto-fallback) step 2 is skipped entirely.

### Zero-miss commit integrity

A matching commit *count* is necessary but not sufficient — two different histories can share a count. After every push (it's skipped on `--dry-run`, which writes nothing), Vector compares the migrated staging mirror against the destination across **three** axes:

1. **the full ref set** — every branch **and** tag we synced exists on the destination;
2. **each ref-tip OID** — the destination tip equals the migrated tip, exactly;
3. **the reachable commit count** — equal on both sides.

For rewrite modes the comparison is against the **post-rewrite** mirror, so OIDs legitimately differ from the original source — that's expected. The rewrite runs with `--prune-empty=never` so counts stay 1:1. On any mismatch Vector aborts with a precise report (which refs differ, the count delta) and **exit code 4** — it never reports success on a mismatch. Branches you deliberately left untouched (a destination that's ahead, or a divergence you didn't force) are reported but don't fail the check, since the remote legitimately differs there.

### Safe multi-run sync (`--sync`)

`--sync` reuses the existing source mirror (delta fetch only), re-applies the **deterministic** rewrite so already-migrated commits keep their existing rewritten OIDs, and pushes new commits as a **fast-forward**. If a branch has genuinely **diverged** (the destination moved in a way that isn't a fast-forward of the rewritten history), Vector **stops with exit code 5** and tells you which refs diverged and how to proceed — it never silently clobbers and never crashes. Mirror semantics, when they require it, use `--force-with-lease` (a compare-and-swap) — never a bare `--force`.

---

## Troubleshooting

| Symptom | Cause & fix |
| --- | --- |
| `git-filter-repo is not installed` | Install it for your OS (see [Prerequisites](#prerequisites-git-filter-repo)); verify with `git filter-repo --version`. Vector fails fast rather than doing partial work. |
| **Exit 5** — "Branch … has DIVERGED" | The destination branch isn't a fast-forward of the rewritten history. Inspect it, then re-run with `--force-existing` to apply the new history (its SHAs change), or `--branch` to exclude it. Vector never overwrites it for you. |
| **Exit 4** — "Integrity MISMATCH" | The destination doesn't match what was migrated (a ref tip or the commit count differs). The report lists the exact refs; re-run, or inspect the destination for outside changes. |
| `the destination should be an SSH URL` | The destination must be SSH (`git@github.com:USER/REPO.git`), which is leak-proof and hang-proof. Convert an HTTPS dest with [GitHub SSH setup](#requirements-github-ssh-access). |
| GitHub SSH auth fails / wrong account | Run `vector-migrate --check`; it names every local key and where to register one. If multiple GitHub accounts share a host, pin the right key with `--ssh-key`. |
| Branch case-conflict warning on macOS/Windows | Two branches whose names (or directory segments) differ only by case can't coexist on a case-insensitive filesystem; Vector resolves them automatically (rename/skip) — choose at the prompt or re-run on Linux/WSL. |

---

## Testing & Quality

Vector ships with a rigorous, fully-offline test suite (Node's built-in runner — no test-framework dependency):

```bash
npm test
```

It covers configuration parsing & validation, mode/URL resolution and the 0-commit fallback decision, the pure integrity comparison (ref set + tip OID + count), programmatic dependency checks (with human-readable errors), the pure push-decision logic, and full integration tests that run the **real pipeline** against local stand-in repositories — asserting idempotency, deterministic SHAs, delta-only rewriting, non-destructive pushes, verbatim Mode-B mirroring, the auto-fallback, sync determinism, the divergence stop (exit 5), and the integrity engine catching a tampered destination (exit 4).

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