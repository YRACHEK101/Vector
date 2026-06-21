#!/usr/bin/env bash
#
# Vector — a migration engine that moves a Git repository from Azure DevOps to
# GitHub while preserving the FULL commit history and re-attributing commits made
# under an old email to a new identity (so they keep counting on the contribution
# graph, at their original dates).
#
# Transport is SSH. HTTPS pushes can stall indefinitely at "Writing objects: 100%"
# on macOS; a single persistent SSH stream avoids that. The run is idempotent and
# safe to re-run: it skips work already done and never force-pushes without asking.
#
# Configuration is resolved in this order (first match wins):
#   1. command-line flags        ./migrate.sh --new-name octocat --branch main
#   2. environment variables     NEW_NAME=octocat ./migrate.sh
#   3. an interactive wizard      prompts for anything still missing, with defaults
#
# Run `./migrate.sh --help` for the full flag reference.
#
set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────────
#  Presentation helpers
# ──────────────────────────────────────────────────────────────────────────────
bold()   { printf '\033[1m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
step()   { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die()    { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# A generic safety net for genuinely unexpected failures (controlled exits go
# through die(), which does not trip this trap).
trap 'printf "\033[31mUnexpected failure near line %s (exit %s). Please re-run; the script is idempotent.\033[0m\n" "$LINENO" "$?" >&2' ERR

# ──────────────────────────────────────────────────────────────────────────────
#  Interaction helpers
# ──────────────────────────────────────────────────────────────────────────────
INTERACTIVE=true
[[ -t 0 ]] || INTERACTIVE=false   # no TTY (piped/CI) → cannot prompt
ASSUME_YES=false

# ask VAR "Prompt" [default] — read a value into VAR, honoring a smart default.
ask() {
  local __var="$1" __prompt="$2" __default="${3:-}" __reply
  if [[ -n "$__default" ]]; then
    read -r -p "$__prompt [$__default]: " __reply
    __reply="${__reply:-$__default}"
  else
    read -r -p "$__prompt: " __reply
  fi
  printf -v "$__var" '%s' "$__reply"
}

# need VAR "Prompt" [default] — ensure VAR has a value: prompt if interactive,
# fall back to the default, otherwise abort with a clear remediation hint.
need() {
  local __var="$1" __prompt="$2" __default="${3:-}"
  [[ -n "${!__var:-}" ]] && return 0
  if $INTERACTIVE; then
    ask "$__var" "$__prompt" "$__default"
  elif [[ -n "$__default" ]]; then
    printf -v "$__var" '%s' "$__default"
  fi
  [[ -n "${!__var:-}" ]] || die "Missing required value: $__var. Provide it via a CLI flag or an environment variable (non-interactive mode)."
}

# confirm "Question?" — y/N prompt; honors --yes, refuses by default with no TTY.
confirm() {
  $ASSUME_YES && return 0
  $INTERACTIVE || return 1
  local r; read -r -p "$1 [y/N] " r; [[ "$r" =~ ^[Yy]$ ]]
}

# git_mirror ... — run git inside the bare mirror, quoting-safe for paths.
git_mirror() { git -C "$MIRROR_DIR" "$@"; }

# ──────────────────────────────────────────────────────────────────────────────
#  Usage
# ──────────────────────────────────────────────────────────────────────────────
usage() {
  cat <<EOF
Vector — Azure DevOps → GitHub migration engine

USAGE
  ./migrate.sh [flags]

Any value not supplied as a flag or environment variable is requested by an
interactive wizard (with smart defaults). Use --non-interactive to fail fast
instead of prompting.

FLAGS                         ENV VAR             DESCRIPTION
  --azure-url <url>           AZURE_URL           Azure DevOps repo clone URL
  --github-ssh <url>          GITHUB_SSH          Target GitHub repo, SSH form:
                                                  git@github.com:USER/REPO.git
  --old-email <email>         OLD_EMAIL           Old email used in Azure commits
  --new-name <name>           NEW_NAME            New author name / GitHub username
  --new-email <email>         NEW_EMAIL           New email (verified on GitHub)
  --project <slug>            PROJECT             Local folder slug (auto-derived)
  --branch <name>             PUSH_BRANCHES       Branch to push (repeatable)
  --branches "a,b c"          PUSH_BRANCHES       Several branches at once
  --extra-old-emails "x,y"    EXTRA_OLD_EMAILS    Additional OLD emails of YOURS
  --ssh-key <path>            SSH_KEY             Private key to use (else auto)
  -y, --yes                                       Assume "yes" for all prompts
  --non-interactive                               Never prompt; require flags/env
  -h, --help                                      Show this help and exit

EXAMPLES
  # Fully interactive — just run it and answer the prompts:
  ./migrate.sh

  # Driven entirely by flags (great for scripting):
  ./migrate.sh \\
    --azure-url "https://org@dev.azure.com/org/Project/_git/Repo" \\
    --github-ssh "git@github.com:octocat/repo.git" \\
    --old-email "old@work.example" --new-name octocat \\
    --new-email "me@personal.example" --branches "main,develop" --yes

  # Driven by environment variables:
  AZURE_URL=... GITHUB_SSH=... OLD_EMAIL=... NEW_NAME=octocat \\
  NEW_EMAIL=... PUSH_BRANCHES="main" ./migrate.sh --non-interactive
EOF
}

# ──────────────────────────────────────────────────────────────────────────────
#  Configuration — seed from environment, then override with CLI flags
# ──────────────────────────────────────────────────────────────────────────────
OLD_EMAIL="${OLD_EMAIL:-}"
NEW_NAME="${NEW_NAME:-}"
NEW_EMAIL="${NEW_EMAIL:-}"
AZURE_URL="${AZURE_URL:-}"
GITHUB_SSH="${GITHUB_SSH:-}"
PROJECT="${PROJECT:-}"
SSH_KEY="${SSH_KEY:-}"
EXTRA_OLD_EMAILS="${EXTRA_OLD_EMAILS:-}"
BRANCH_INPUT="${PUSH_BRANCHES:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --azure-url)        AZURE_URL="${2:?--azure-url needs a value}";        shift 2 ;;
    --github-ssh)       GITHUB_SSH="${2:?--github-ssh needs a value}";      shift 2 ;;
    --old-email)        OLD_EMAIL="${2:?--old-email needs a value}";        shift 2 ;;
    --new-name)         NEW_NAME="${2:?--new-name needs a value}";          shift 2 ;;
    --new-email)        NEW_EMAIL="${2:?--new-email needs a value}";        shift 2 ;;
    --project)          PROJECT="${2:?--project needs a value}";            shift 2 ;;
    --ssh-key)          SSH_KEY="${2:?--ssh-key needs a value}";            shift 2 ;;
    --branch|--branches) BRANCH_INPUT="$BRANCH_INPUT ${2:?$1 needs a value}"; shift 2 ;;
    --extra-old-emails) EXTRA_OLD_EMAILS="${2:?--extra-old-emails needs a value}"; shift 2 ;;
    -y|--yes)           ASSUME_YES=true;   shift ;;
    --non-interactive)  INTERACTIVE=false; shift ;;
    -h|--help)          usage; exit 0 ;;
    *)                  die "Unknown argument: $1 (run --help)" ;;
  esac
done

# split_branches "a,b c" → BRANCHES=(a b c)  (comma- and whitespace-tolerant)
split_branches() {
  local raw tmp x
  raw="$1"; tmp="${raw//,/ }"
  BRANCHES=()
  for x in $tmp; do [[ -n "$x" ]] && BRANCHES+=("$x"); done
}

# derive a sensible local slug from the GitHub SSH URL (…/REPO.git → REPO)
default_project_from_ssh() {
  local repo="${1##*/}"; printf '%s' "${repo%.git}"
}

# ──────────────────────────────────────────────────────────────────────────────
#  Interactive wizard — fills in whatever is still missing
# ──────────────────────────────────────────────────────────────────────────────
bold "Vector — Azure DevOps → GitHub migration engine"
$INTERACTIVE && yellow "Press Enter to accept the [default] shown in each prompt."

need AZURE_URL  "Azure DevOps repository clone URL"
need GITHUB_SSH "Target GitHub repo (SSH form, git@github.com:USER/REPO.git)"
need PROJECT    "Short project slug (local folders only)" "$(default_project_from_ssh "$GITHUB_SSH")"
need OLD_EMAIL  "Old email used in the Azure commits"
need NEW_NAME   "New author name / GitHub username" "$(git config --global user.name 2>/dev/null || whoami)"
need NEW_EMAIL  "New email (must be verified on GitHub)" "$(git config --global user.email 2>/dev/null || true)"

split_branches "$BRANCH_INPUT"
if ((${#BRANCHES[@]} == 0)); then
  if $INTERACTIVE; then
    ask _BR "Branch(es) to push (space/comma separated)" "main"; split_branches "$_BR"
  else
    split_branches "main"
  fi
fi

# Collect all OLD emails to remap (yours only — never a teammate's).
ALL_OLD=("$OLD_EMAIL")
if [[ -n "$EXTRA_OLD_EMAILS" ]]; then
  for _e in ${EXTRA_OLD_EMAILS//,/ }; do [[ -n "$_e" ]] && ALL_OLD+=("$_e"); done
fi

# Derived, internal paths.
MIRROR_DIR="$(pwd)/${PROJECT}-migration.git"
MAILMAP_FILE="$(pwd)/${PROJECT}-mailmap.txt"

step "Configuration"
printf '  %-14s %s\n' "Azure URL:"   "$AZURE_URL"
printf '  %-14s %s\n' "GitHub SSH:"  "$GITHUB_SSH"
printf '  %-14s %s\n' "Identity:"    "$NEW_NAME <$NEW_EMAIL>"
printf '  %-14s %s\n' "Remap from:"  "${ALL_OLD[*]}"
printf '  %-14s %s\n' "Branches:"    "${BRANCHES[*]}"
printf '  %-14s %s\n' "Mirror dir:"  "$MIRROR_DIR"
confirm "Proceed with this configuration?" || die "Aborted by user."

# ──────────────────────────────────────────────────────────────────────────────
#  0. Prerequisites
# ──────────────────────────────────────────────────────────────────────────────
step "Checking prerequisites"
command -v git >/dev/null 2>&1 || die "git is not installed."
command -v git-filter-repo >/dev/null 2>&1 \
  || die "git-filter-repo missing. Install: brew install git-filter-repo (or pip3 install --user git-filter-repo)"
green "git + git-filter-repo found."
yellow "Reminder: '$NEW_EMAIL' must be ADDED and VERIFIED at https://github.com/settings/emails"
yellow "          or the rewritten commits will not appear on your contribution graph."

# ──────────────────────────────────────────────────────────────────────────────
#  1. SSH key — detect dynamically, then ensure it is on the CORRECT account
# ──────────────────────────────────────────────────────────────────────────────
# Print every ~/.ssh private key that has a matching .pub, one per line.
find_ssh_keys() {
  local pub priv
  shopt -s nullglob
  for pub in "$HOME"/.ssh/*.pub; do
    priv="${pub%.pub}"
    [[ -f "$priv" ]] && printf '%s\n' "$priv"
  done
  shopt -u nullglob
}

# Resolve SSH_KEY by: explicit choice → key loaded in the agent → sole/selected
# key on disk → generate a fresh ed25519 key.
resolve_ssh_key() {
  if [[ -n "$SSH_KEY" ]]; then
    [[ -f "$SSH_KEY" ]] || die "Specified --ssh-key not found: $SSH_KEY"
    green "Using specified SSH key: $SSH_KEY"; return
  fi

  local candidates=() agent_fps k fp choice i
  while IFS= read -r k; do [[ -n "$k" ]] && candidates+=("$k"); done < <(find_ssh_keys)
  agent_fps="$(ssh-add -l 2>/dev/null || true)"

  # Prefer a key already loaded into the running ssh-agent.
  if [[ -n "$agent_fps" ]]; then
    for k in "${candidates[@]:-}"; do
      [[ -n "$k" ]] || continue
      fp="$(ssh-keygen -lf "$k.pub" 2>/dev/null | awk '{print $2}')"
      if [[ -n "$fp" ]] && grep -qF "$fp" <<<"$agent_fps"; then
        SSH_KEY="$k"; green "Using SSH key loaded in agent: $SSH_KEY"; return
      fi
    done
  fi

  if ((${#candidates[@]} == 1)); then
    SSH_KEY="${candidates[0]}"; green "Found SSH key: $SSH_KEY"; return
  elif ((${#candidates[@]} > 1)); then
    if $INTERACTIVE; then
      yellow "Multiple SSH keys found in ~/.ssh:"
      i=1; for k in "${candidates[@]}"; do printf '  %d) %s\n' "$i" "$k"; i=$((i+1)); done
      read -r -p "Choose a key [1]: " choice; choice="${choice:-1}"
      SSH_KEY="${candidates[$((choice-1))]:-${candidates[0]}}"
    else
      SSH_KEY="${candidates[0]}"
    fi
    green "Using SSH key: $SSH_KEY"; return
  fi

  yellow "No SSH key pair found in ~/.ssh — generating a new ed25519 key."
  SSH_KEY="$HOME/.ssh/id_ed25519"
  mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"
  ssh-keygen -t ed25519 -C "$NEW_EMAIL" -f "$SSH_KEY" -N ""
  green "Key generated: $SSH_KEY"
}

step "SSH key for GitHub account: $NEW_NAME"
resolve_ssh_key
PUB="${SSH_KEY}.pub"
[[ -f "$PUB" ]] || ssh-keygen -y -f "$SSH_KEY" > "$PUB" 2>/dev/null || die "Cannot derive public key for $SSH_KEY"
KEY_BODY="$(awk '{print $2}' "$PUB")"

# Use the resolved key for every git transport from here on.
export GIT_SSH_COMMAND="ssh -i $SSH_KEY -o BatchMode=yes -o IdentitiesOnly=yes"

# Trust github.com's host key up front so nothing blocks mid-run.
mkdir -p "$HOME/.ssh"; touch "$HOME/.ssh/known_hosts"
ssh-keygen -F github.com >/dev/null 2>&1 || ssh-keyscan github.com >> "$HOME/.ssh/known_hosts" 2>/dev/null

# GitHub publishes every account's public keys; poll until ours is on NEW_NAME.
while ! curl -fsSL "https://github.com/${NEW_NAME}.keys" 2>/dev/null | grep -qF "$KEY_BODY"; do
  if command -v pbcopy >/dev/null 2>&1; then pbcopy < "$PUB"; PASTED="(copied to your clipboard)"; else PASTED=""; fi
  yellow "This key is not yet on GitHub account '$NEW_NAME'. Add it $PASTED:"
  echo  "  1) Open https://github.com/settings/ssh/new"
  echo  "  2) Confirm the avatar is '$NEW_NAME' (not a work/org account)"
  echo  "  3) Type = Authentication Key, paste this, then Save:"
  echo  "     $(cat "$PUB")"
  echo  "  NOTE: 'Key is already in use' = it is on another account; remove it there first."
  $INTERACTIVE || die "SSH key is not on '$NEW_NAME' and we are non-interactive. Add it and re-run."
  confirm "Re-check now? (n = abort)" || die "Add the key to '$NEW_NAME', then re-run."
done
green "Key is registered on '$NEW_NAME'."

# Verify auth. GitHub's `ssh -T` always exits non-zero, so inspect the message.
AUTH_OUT="$(ssh -i "$SSH_KEY" -o BatchMode=yes -T git@github.com 2>&1 || true)"
if grep -q "successfully authenticated" <<<"$AUTH_OUT"; then
  green "SSH authentication OK."
else
  printf '%s\n' "$AUTH_OUT" >&2
  die "SSH authentication to GitHub failed — check the key on '$NEW_NAME' and re-run."
fi

# ──────────────────────────────────────────────────────────────────────────────
#  2. Bare mirror clone from Azure DevOps (reused if present)
# ──────────────────────────────────────────────────────────────────────────────
step "Bare mirror from Azure DevOps"
if [[ -d "$MIRROR_DIR" ]]; then
  green "Reusing existing mirror: $MIRROR_DIR"
else
  if ! git clone --mirror "$AZURE_URL" "$MIRROR_DIR"; then
    cat >&2 <<EOF

── could not mirror-clone the Azure repository ─────────────────────────────────
  • Double-check the URL:        $AZURE_URL
  • Azure DevOps over HTTPS needs a PAT or Git Credential Manager. Test access:
        git ls-remote "$AZURE_URL"
  • If it hangs forever at a prompt, no Azure credential is cached for this host.
EOF
    die "Mirror clone failed (see above)."
  fi
  green "Mirror cloned: $MIRROR_DIR"
fi

# ──────────────────────────────────────────────────────────────────────────────
#  3. Show identities, then rewrite YOUR old email(s) — idempotent
# ──────────────────────────────────────────────────────────────────────────────
step "Identities currently in history"
git_mirror log --all --format='%an <%ae>' | sort -u

NEEDS_REWRITE=false
for e in "${ALL_OLD[@]}"; do
  [[ -n "$e" ]] || continue
  if git_mirror log --all --format='%ae%n%ce' | grep -qiF "$e"; then NEEDS_REWRITE=true; fi
done

if $NEEDS_REWRITE; then
  step "Rewriting author + committer for your old email(s)"
  : > "$MAILMAP_FILE"
  for e in "${ALL_OLD[@]}"; do
    [[ -n "$e" ]] && printf '%s <%s> <%s>\n' "$NEW_NAME" "$NEW_EMAIL" "$e" >> "$MAILMAP_FILE"
  done
  bold "mailmap:"; cat "$MAILMAP_FILE"; echo
  if ! git_mirror filter-repo --mailmap "$MAILMAP_FILE" --force; then
    cat >&2 <<EOF

── git-filter-repo failed ──────────────────────────────────────────────────────
The history rewrite did not complete. Your GitHub repo is untouched. Common causes:

  • Not installed / too old:
        brew install git-filter-repo        # macOS
        pip3 install --user git-filter-repo  # any platform
        git filter-repo --version
  • "expected freshly packed repo": the mirror is no longer pristine. Delete and
    re-run (the script is idempotent and will re-clone):
        rm -rf "$MIRROR_DIR"
  • Malformed mailmap — each line must read  Name <new@email> <old@email>:
        cat "$MAILMAP_FILE"
EOF
    die "git-filter-repo failed (see above)."
  fi
  green "History rewritten."
else
  green "No matching old email in history — already rewritten, skipping."
fi

# Safety gate: none of YOUR old emails may remain before we push.
for e in "${ALL_OLD[@]}"; do
  [[ -n "$e" ]] || continue
  if git_mirror log --all --format='%ae%n%ce' | grep -qiF "$e"; then
    die "Old email '$e' STILL present in history — aborting before push."
  fi
done
green "Verified: none of your old emails remain. Final identities:"
git_mirror log --all --format='%an <%ae>' | sort -u

# ──────────────────────────────────────────────────────────────────────────────
#  4. Push selected branches over SSH (idempotent; detects already-pushed)
# ──────────────────────────────────────────────────────────────────────────────
# Print actionable diagnostics, distinguishing a network/SSH drop from a
# repository-side rejection.
diagnose_push_failure() {
  local b="$1" probe
  probe="$(ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=10 -T git@github.com 2>&1 || true)"
  yellow "── push of branch '$b' failed ──────────────────────────────────────────"
  if ! grep -q "successfully authenticated" <<<"$probe"; then
    cat >&2 <<EOF
Cannot reach GitHub over SSH right now — this looks like a NETWORK or AUTH drop:

  • Check connectivity:        ssh -T git@github.com
  • Corporate VPN/proxy often blocks port 22. Add to ~/.ssh/config and retry:
        Host github.com
          Hostname ssh.github.com
          Port 443
  • Re-confirm the key is on '$NEW_NAME':
        curl -s https://github.com/$NEW_NAME.keys

Nothing was rewritten or lost. Re-run when connectivity is back — already-pushed
branches are detected and skipped.
EOF
  else
    cat >&2 <<EOF
SSH to GitHub works, so this is a REPOSITORY-SIDE rejection, not a network drop:

  • The branch may be protected, or the remote holds commits yours do not.
  • Confirm the target exists and you have write access:
        git ls-remote "$GITHUB_SSH"
  • "cannot lock ref ... already exists" usually means a prior push DID succeed —
    compare the SHAs:
        git ls-remote "$GITHUB_SSH" refs/heads/$b
EOF
  fi
}

push_branches() {
  step "Pushing branch(es) to GitHub over SSH: ${BRANCHES[*]}"
  local b local_sha remote_sha
  for b in "${BRANCHES[@]}"; do
    local_sha="$(git_mirror rev-parse "refs/heads/$b" 2>/dev/null || true)"
    if [[ -z "$local_sha" ]]; then yellow "[$b] not found in mirror — skipping."; continue; fi
    remote_sha="$(git ls-remote "$GITHUB_SSH" "refs/heads/$b" 2>/dev/null | awk '{print $1}')"

    if [[ "$remote_sha" == "$local_sha" ]]; then
      green "[$b] already on GitHub at $local_sha — nothing to push."
    elif [[ -z "$remote_sha" ]]; then
      if git_mirror push "$GITHUB_SSH" "refs/heads/$b:refs/heads/$b"; then
        green "[$b] pushed."
      else
        diagnose_push_failure "$b"; die "Push of '$b' failed."
      fi
    else
      yellow "[$b] remote=$remote_sha differs from local=$local_sha."
      if confirm "Force-push to overwrite remote '$b'?"; then
        if git_mirror push --force "$GITHUB_SSH" "refs/heads/$b:refs/heads/$b"; then
          green "[$b] force-pushed."
        else
          diagnose_push_failure "$b"; die "Force-push of '$b' failed."
        fi
      else
        yellow "[$b] skipped (remote left as-is)."
      fi
    fi
  done
}
push_branches

# ──────────────────────────────────────────────────────────────────────────────
#  5. Verify remote matches local
# ──────────────────────────────────────────────────────────────────────────────
verify_remote() {
  step "Verification (remote vs local)"
  local b local_sha remote_sha n
  for b in "${BRANCHES[@]}"; do
    local_sha="$(git_mirror rev-parse "refs/heads/$b" 2>/dev/null || true)"
    [[ -n "$local_sha" ]] || continue
    remote_sha="$(git ls-remote "$GITHUB_SSH" "refs/heads/$b" 2>/dev/null | awk '{print $1}')"
    n="$(git_mirror rev-list --count "refs/heads/$b")"
    if [[ "$remote_sha" == "$local_sha" ]]; then
      green "[$b] OK — remote == local ($local_sha, $n commits)"
    else
      die "[$b] MISMATCH — local=$local_sha remote=${remote_sha:-<none>}"
    fi
  done
}
verify_remote

cat <<DONE

$(green "✅ Migration complete.")
Next steps:
  • https://github.com/settings/emails — make sure '$NEW_EMAIL' is verified.
  • Set the default branch on GitHub if needed (Settings → Branches).
  • Your commits appear on the contribution graph at their ORIGINAL dates.

Cleanup when satisfied:
  rm -rf "$MIRROR_DIR" "$MAILMAP_FILE"
DONE
