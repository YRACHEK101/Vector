# 🧭 Vector

**A professional, zero-token CLI utility for migrating Git repositories from Azure DevOps to GitHub — without losing your history or your green squares.**

---

## 📖 1. What is Vector?

Vector is a professional, **zero-token** command-line utility that bridges your repositories from **Azure DevOps** to **GitHub** seamlessly — preserving the complete commit history and re-attributing your authorship so your public contribution graph survives the move. It runs as a single, auditable script with **no Personal Access Tokens, no SaaS, and no manual git surgery**, driven entirely by CLI flags, environment variables, or a friendly interactive wizard.

```bash
./migrate.sh            # interactive wizard — just answer the prompts
./migrate.sh --check    # preflight: validate tools + config, change nothing
```

---

## 🛑 The Real-World Problem It Solves

Moving from a closed enterprise ecosystem (Azure DevOps) to a public one (GitHub) looks like a simple `push` — until it quietly costs you your history, your security, or an afternoon staring at a frozen terminal. Vector exists to kill three specific pains:

### 🟩 The Graph Loss
Inside a company you commit with a **corporate email** (`you@bigcorp.com`). A plain migration carries those commits over verbatim — and because GitHub only credits commits authored by an email **verified on your account**, every one of them becomes an unattributed "ghost" commit. The result: months or years of real work that **never shows up on your public contribution graph**. Vector rewrites *only your* old corporate identity to your personal verified identity (leaving teammates untouched), so your green squares come back — at their **original commit dates**.

### 🔐 The Data Leak Risk
The quick-and-dirty way to authenticate a migration is to paste a **Personal Access Token directly into a clone URL** or a config file. That token then leaks into your shell history, your `.git/config`, and any logs — a credential time-bomb. Vector is **zero-token**: it authenticates over **SSH keys** only, so there is no secret to hardcode, log, or accidentally commit.

### 🧊 The Push Hang
Pushing a large history over **HTTPS frequently freezes at `Writing objects: 100%`** on macOS and Linux — the client stalls waiting on a server acknowledgment that never seems to arrive (a well-known buffering issue). Vector sidesteps it entirely by streaming over a **single persistent SSH connection**, so big repositories transfer reliably.

---

## 🛠️ How to Configuration (Line-by-Line Guide)

> **You never edit the script.** Vector resolves every value in this order:
> **CLI flags → environment variables → interactive wizard** (with smart defaults).

The cleanest way to run it dynamically is to **export the configuration block** below, then run the script. Copy it, fill in your values, and paste it into your terminal (or a `.env` you `source`):

```bash
# ── Vector configuration ─────────────────────────────────────────────────────
export PROJECT="my-repo"                                    # local folder slug
export OLD_EMAIL="you@old-corp.com"                         # corporate email in old commits
export NEW_NAME="your-github-username"                      # GitHub username
export NEW_EMAIL="you@personal.com"                         # personal, GitHub-verified email
export AZURE_URL="https://org@dev.azure.com/org/Project/_git/Repo"
export GITHUB_SSH="git@github.com:your-user/your-repo.git"  # destination repo, SSH form
export PUSH_BRANCHES="main develop"                         # branch(es) to synchronize
# ─────────────────────────────────────────────────────────────────────────────

./migrate.sh
```

Exactly what each line means:

| Line / Variable | What to put there | Notes |
|---|---|---|
| `PROJECT` | A short **local folder slug** | Names the on-disk mirrors (`my-repo-source.git`, `my-repo-migration.git`). Auto-derived from `GITHUB_SSH` if omitted. |
| `OLD_EMAIL` | The **old corporate email** bound to your old commits | This — and only this — is remapped. Teammates' commits stay theirs. |
| `NEW_NAME` | Your **GitHub username** | Used as the new author name and to confirm your SSH key is on the right account. |
| `NEW_EMAIL` | Your **personal, GitHub-verified email** | **Must** be verified at <https://github.com/settings/emails> or the graph won't light up. |
| `AZURE_URL` | The **source** Azure DevOps clone URL | The `…/_git/Repo` HTTPS URL. |
| `GITHUB_SSH` | The **destination** GitHub repo, SSH form | `git@github.com:USER/REPO.git` — create the repo empty first. |
| `PUSH_BRANCHES` | The **branches to synchronize** | Space- or comma-separated, e.g. `"main develop"`. |

**Prefer flags?** Every variable has a flag equivalent, and `PUSH_BRANCHES` accepts the array-style `--branch` repeated or `--branches`:

```bash
./migrate.sh \
  --project my-repo \
  --old-email you@old-corp.com \
  --new-name your-github-username \
  --new-email you@personal.com \
  --azure-url "https://org@dev.azure.com/org/Project/_git/Repo" \
  --github-ssh "git@github.com:your-user/your-repo.git" \
  --branch main --branch develop      # ← array of branches, one flag each
```

Run `./migrate.sh --help` for the full reference, or `./migrate.sh --check` to validate your configuration and tools **without making any changes**.

---

## 🔄 How to Use It for Existing Projects & Incremental Updates

Migration is rarely one-and-done — work keeps landing on Azure DevOps after your first push. **Vector is designed to be re-run as often as you like.** Just run it again with the same configuration:

```bash
./migrate.sh        # run it again whenever Azure has new commits
```

Each subsequent run is **incremental and strictly non-destructive**:

1. **Fetches only the new commits** from Azure into a pristine local mirror — it never re-clones and never corrupts what's already there.
2. **Re-applies your identity rewrite deterministically**, so commits already on GitHub keep the **exact same SHAs**.
3. **Fast-forwards just the new commits** onto GitHub. Existing history is left **byte-for-byte intact** — nothing is rewritten or crushed.
4. **Never overwrites GitHub.** If the remote is *ahead* of your local copy, or the histories have genuinely **diverged**, Vector stops and tells you instead of clobbering anything — it will only ever force-push a true divergence after you **explicitly confirm**.

In short: the **first run migrates**, and **every run after that safely tops up** the destination. You can wire `./migrate.sh --non-interactive --yes` into a cron job or CI step for hands-off, continuous mirroring.

---

## 💻 OS-Specific Installation & Execution Commands

Vector needs two tools: **`git`** and **[`git-filter-repo`](https://github.com/newren/git-filter-repo)**. Install per your OS, then run.

| OS | Install the dependency | Run Vector |
|---|---|---|
| **macOS** | `brew install git-filter-repo` | `chmod +x migrate.sh && ./migrate.sh` |
| **Linux (Ubuntu/Debian)** | `sudo apt install git-filter-repo`  *(or `pip3 install --user git-filter-repo`)* | `chmod +x migrate.sh && ./migrate.sh` |
| **Windows** | `pip install git-filter-repo` (needs Python) | run via **Git Bash** / **WSL**: `bash migrate.sh` |

### 🍎 macOS

```bash
brew install git-filter-repo     # Homebrew provides both git and git-filter-repo
chmod +x migrate.sh
./migrate.sh --check             # optional: confirm everything is ready
./migrate.sh
```

### 🐧 Linux (Ubuntu / Debian)

```bash
# Recent distros ship a package; otherwise use pip:
sudo apt update && sudo apt install -y git git-filter-repo
#   ── or ──
pip3 install --user git-filter-repo

chmod +x migrate.sh
./migrate.sh
```

### 🪟 Windows

Vector is a Bash script, so run it through a Bash environment. Pick one:

- **Git Bash** (simplest) — comes with [Git for Windows](https://git-scm.com/download/win):
  ```bash
  # In a Git Bash terminal:
  pip install git-filter-repo        # requires Python on PATH
  bash migrate.sh
  ```
- **WSL (Windows Subsystem for Linux)** — recommended for large repos; treat it exactly like Linux:
  ```bash
  sudo apt install -y git git-filter-repo   # or: pip3 install --user git-filter-repo
  bash migrate.sh
  ```
- **PowerShell** — PowerShell can't execute a Bash script directly, so **wrap it with bash** (installed by Git for Windows):
  ```powershell
  # Install Python + git-filter-repo first:
  pip install git-filter-repo
  # Then hand the script to bash:
  bash .\migrate.sh
  ```

> On native Windows without WSL, make sure **Python** is installed and on your `PATH` so `pip install git-filter-repo` works and `git filter-repo` is callable.

---

## ✅ Verify Your Setup

Before a real run, two safe, no-op commands confirm everything is wired correctly:

```bash
./migrate.sh --check        # validates tools + configuration, makes no changes
bash tests/run_tests.sh     # runs the offline automated test suite
```

---

## 📄 License

Released under the **MIT License**.

```
MIT License

Copyright (c) 2026 Vector contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
