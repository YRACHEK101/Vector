# Vector — Azure DevOps → GitHub Migration Engine

> A universal migration bridge for moving Git repositories from **Azure DevOps**
> to **GitHub** *safely* — without losing author attribution or your green
> contribution graph.

Vector mirrors a repository's **entire commit history** to GitHub and, in the
same pass, re-attributes the commits you authored under an old work email to your
new identity — so they land on your contribution graph at their **original
dates**. Teammates' commits are never touched.

It is a single, dependency-light Bash script designed to be **safe by default**:

- **Idempotent** — re-run it anytime; it detects work already done and skips it.
- **Never destructive without consent** — it asks before any force-push.
- **Zero secrets on disk** — transport is SSH; no tokens in URLs or `.git/config`.
- **Config-free to start** — flags, environment variables, *or* an interactive
  wizard. You never have to edit the script.

---

## Why Vector?

Azure DevOps and GitHub model identity differently, and a naïve `git push` of a
mirrored repo will scatter your history across "ghost" authors — none of which
count toward your GitHub profile. The common workarounds (manual `filter-branch`
incantations, paid migration SaaS, HTTPS pushes that mysteriously hang at
`Writing objects: 100%` on macOS) are fragile or opaque.

Vector packages the reliable path into one auditable script you can read top to
bottom in a couple of minutes.

---

## Quick start

```bash
# 1. Clone this repository
git clone <this-repo-url> vector && cd vector
chmod +x migrate.sh

# 2a. Run the interactive wizard — just answer the prompts
./migrate.sh
```

That's it. The only step Vector cannot do for you is **pasting your SSH public
key into GitHub** (it requires your logged-in browser) — and it walks you through
that, copying the key to your clipboard and polling until it's registered.

### Option B — drive it with flags

```bash
./migrate.sh \
  --azure-url  "https://org@dev.azure.com/org/Project/_git/Repo" \
  --github-ssh "git@github.com:octocat/repo.git" \
  --old-email  "old@work.example" \
  --new-name   "octocat" \
  --new-email  "me@personal.example" \
  --branches   "main,develop" \
  --yes
```

### Option C — drive it with environment variables

```bash
export AZURE_URL="https://org@dev.azure.com/org/Project/_git/Repo"
export GITHUB_SSH="git@github.com:octocat/repo.git"
export OLD_EMAIL="old@work.example"
export NEW_NAME="octocat"
export NEW_EMAIL="me@personal.example"
export PUSH_BRANCHES="main,develop"
./migrate.sh --non-interactive
```

Precedence is **CLI flags → environment variables → interactive prompt**. Mix and
match freely: set the stable values in your environment and override per-run with
flags.

### Configuration reference

| Flag | Environment variable | Description |
|---|---|---|
| `--azure-url` | `AZURE_URL` | Azure DevOps repository clone URL |
| `--github-ssh` | `GITHUB_SSH` | Target GitHub repo in **SSH** form: `git@github.com:USER/REPO.git` |
| `--old-email` | `OLD_EMAIL` | The old email used in your Azure commits |
| `--new-name` | `NEW_NAME` | New author name / GitHub username |
| `--new-email` | `NEW_EMAIL` | New email — **must be verified** on GitHub |
| `--project` | `PROJECT` | Local folder slug (auto-derived from the repo name) |
| `--branch` / `--branches` | `PUSH_BRANCHES` | Branch(es) to push; comma- or space-separated, repeatable |
| `--extra-old-emails` | `EXTRA_OLD_EMAILS` | Additional old emails **of yours** to remap |
| `--ssh-key` | `SSH_KEY` | Specific private key to use (otherwise auto-detected) |
| `-y`, `--yes` | — | Assume "yes" for every confirmation prompt |
| `--non-interactive` | — | Never prompt; require flags/env (ideal for CI) |
| `-h`, `--help` | — | Print the full flag reference |

Run `./migrate.sh --help` at any time for the same reference.

---

## Prerequisites

Vector checks and, where possible, handles these for you:

1. **Tools:** `git` and [`git-filter-repo`](https://github.com/newren/git-filter-repo)
   (`brew install git-filter-repo`, or `pip3 install --user git-filter-repo`).
2. **Verified email:** add `NEW_EMAIL` at <https://github.com/settings/emails> —
   *required* for commits to appear on your graph.
3. **Empty target repo** on GitHub — create it with **no** README, `.gitignore`,
   or license, so history can be pushed cleanly.
4. **An SSH key on the correct account** — Vector auto-detects one (or generates
   it) and waits until it sees the key registered on `NEW_NAME`.

---

## How it works

Vector runs a short, auditable pipeline. Each stage is idempotent and verified
before the next begins:

```
  Azure DevOps                                            GitHub
  ┌──────────┐   1. bare mirror   ┌───────────────┐   3. SSH push   ┌────────┐
  │  source  │ ─────────────────▶ │  <slug>-      │ ──────────────▶ │ target │
  │   repo   │   (full history)   │  migration.git│   (per branch)  │  repo  │
  └──────────┘                    └───────┬───────┘                 └────────┘
                                          │
                          2. mailmap rewrite via git-filter-repo
                             (old email → new identity, all refs)
```

1. **Dynamic SSH key resolution.** Instead of assuming a fixed key path, Vector
   inspects the running `ssh-agent`, then scans `~/.ssh/` for available key pairs
   (prompting if several exist), and only generates a fresh `ed25519` key if none
   are found. It pins that key for the whole run via `GIT_SSH_COMMAND`, trusts
   `github.com`'s host key, polls `https://github.com/<USER>.keys` until the key
   is live on the **right** account, and confirms `ssh -T git@github.com`.

2. **Bare mirror clone.** `git clone --mirror` pulls the complete object graph —
   every branch, tag, and note — into a local `*-migration.git`. The mirror is
   reused on re-runs, so an interrupted migration resumes instead of restarting.

3. **Mailmap rewriting.** A `mailmap` is generated from your old email(s) and
   applied with `git filter-repo --mailmap`. This rewrites the **author,
   committer, and tagger** fields across all refs — and *only* for the emails you
   listed, leaving collaborators' commits intact. The step is skipped entirely if
   no matching email remains, and a safety gate aborts the run if any of your old
   emails survive the rewrite.

4. **Dedicated SSH streaming push.** Each requested branch is pushed over a single
   persistent SSH connection — sidestepping the macOS HTTPS hang at
   `Writing objects: 100%`. Vector compares remote and local tips first: it skips
   branches already in sync, pushes missing ones outright, and asks before
   force-pushing any that diverge.

5. **Verification.** After pushing, Vector re-reads each remote tip and confirms
   it matches the local SHA (with a commit count) before reporting success.

> **Why SSH, not HTTPS?** On macOS, HTTPS pushes reliably freeze at
> `Writing objects: 100%` — the client waiting on a server acknowledgment, not a
> slow upload. A single SSH stream avoids the stall and keeps secrets off disk.

---

## Troubleshooting

**`Permission denied (publickey)`**
The key isn't on the target account. Check what GitHub sees for it:
```bash
curl -s https://github.com/<USER>.keys   # empty = no keys on that account
```
Make sure your browser is signed into the right account
(<https://github.com/settings/keys>). "Key is already in use" when adding means
the key lives on **another** account — remove it there, or let Vector generate a
fresh one.

**Push freezes at `Writing objects: 100%`**
That's the HTTPS hang. Vector already uses SSH; if you're pushing manually, switch
to the SSH remote.

**`cannot lock ref 'refs/heads/<b>': reference already exists`**
A previous (seemingly frozen) push actually succeeded server-side. Confirm it's
the same commit, and you're done:
```bash
git ls-remote git@github.com:USER/REPO.git refs/heads/<b>   # compare to local
```

**Two authors after migration**
Expected. Only **your** old email is remapped; a teammate's commits correctly stay
attributed to them. Don't claim others' work.

**Green squares not showing**
- Confirm `NEW_EMAIL` is **verified** at <https://github.com/settings/emails>.
- Commits appear at their **original dates** — navigate to that year on your
  profile.
- Commits must be on the **default branch** (set it in Settings → Branches).

---

## Security

- **Never** put a Personal Access Token in a URL or commit — it leaks into shell
  history and `.git/config`. Vector uses **SSH keys** exclusively, so there are no
  tokens to leak.
- If a token is ever exposed, revoke it immediately at
  <https://github.com/settings/tokens>.

---

## Contributing

Contributions are welcome — bug reports, docs, and features alike.

1. **Open an issue first** for anything non-trivial, describing the problem and
   your environment (OS, `bash --version`, `git --version`,
   `git filter-repo --version`). Vector targets Bash 3.2+ for macOS
   compatibility, so please avoid Bash 4-only features (`mapfile`, `${var,,}`,
   associative arrays).
2. **Fork and branch** from `main` (`feat/<topic>` or `fix/<topic>`).
3. **Format & lint** before committing:
   ```bash
   shellcheck migrate.sh     # static analysis
   bash -n migrate.sh        # syntax check
   ```
4. **Write clear commits** using [Conventional Commits](https://www.conventionalcommits.org)
   (`feat:`, `fix:`, `docs:`, `refactor:`…).
5. **Open a Pull Request** describing the change and how you tested it. Keep PRs
   focused and small where possible.

---

## License

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
