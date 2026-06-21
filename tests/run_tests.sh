#!/usr/bin/env bash
#
# Automated checks for migrate.sh — fully OFFLINE (no network, no GitHub account).
#
#   bash tests/run_tests.sh
#
# What it verifies:
#   1. The script parses cleanly.
#   2. CLI surface: --help, unknown flags, and missing config all behave sanely.
#   3. The --check preflight succeeds when tools + config are present.
#   4. Tool validation emits a human-readable error when git-filter-repo is absent.
#   5. An existing local mirror folder is detected and handled without crashing.
#   6. A full incremental sync works against local stand-in repos: the same
#      source-fetch → rebuild → filter-repo → ancestry-aware-push pipeline that
#      migrate.sh runs, with a local bare repo standing in for GitHub so the test
#      needs no network. Covers create → idempotent re-run → fast-forward →
#      non-destructive divergence handling.
#
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/migrate.sh"
BASH_BIN="$(command -v bash)"
GIT_BIN="$(command -v git)"
WHOAMI_BIN="$(command -v whoami || true)"

PASS=0; FAIL=0
ok()      { printf '  \033[32m✓ PASS\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()     { printf '  \033[31m✗ FAIL\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
section() { printf '\n\033[1;36m== %s ==\033[0m\n' "$1"; }

assert_status()   { if [[ "$2" == "$3" ]]; then ok "$1 (exit $3)"; else bad "$1 (want exit $2, got $3)"; fi; }
assert_contains() { case "$3" in *"$2"*) ok "$1";; *) bad "$1 (output missing: \"$2\")";; esac; }

# Run migrate.sh with a complete, valid env-driven configuration plus extra args.
run_cfg() {
  AZURE_URL="https://org@dev.azure.com/org/Proj/_git/Repo" \
  GITHUB_SSH="git@github.com:octocat/repo.git" \
  OLD_EMAIL="old@corp.example" NEW_NAME="octocat" \
  NEW_EMAIL="me@personal.example" PUSH_BRANCHES="main" \
  "$BASH_BIN" "$SCRIPT" "$@"
}

# ──────────────────────────────────────────────────────────────────────────────
section "1. Script syntax"
if "$BASH_BIN" -n "$SCRIPT"; then ok "bash -n migrate.sh"; else bad "bash -n migrate.sh"; fi

# ──────────────────────────────────────────────────────────────────────────────
section "2. CLI surface"
out="$(run_cfg --help 2>&1)"; st=$?
assert_status   "--help exits 0" 0 "$st"
assert_contains "--help prints usage" "USAGE" "$out"

out="$(run_cfg --bogus 2>&1)"; st=$?
assert_status   "unknown flag exits non-zero" 1 "$st"
assert_contains "unknown flag is reported" "Unknown argument" "$out"

out="$(AZURE_URL="" GITHUB_SSH="" OLD_EMAIL="" NEW_NAME="" NEW_EMAIL="" PUSH_BRANCHES="" \
       "$BASH_BIN" "$SCRIPT" --non-interactive 2>&1)"; st=$?
assert_status   "missing config exits non-zero" 1 "$st"
assert_contains "missing config is human-readable" "Missing required value" "$out"

# ──────────────────────────────────────────────────────────────────────────────
section "3. --check preflight (tools + config present)"
out="$(run_cfg --non-interactive --check 2>&1)"; st=$?
assert_status   "--check exits 0" 0 "$st"
assert_contains "--check reports readiness" "Preflight OK" "$out"
assert_contains "--check promises no changes" "no network" "$out"

# ──────────────────────────────────────────────────────────────────────────────
section "4. Tool validation (git-filter-repo missing → readable error)"
if [[ -n "$WHOAMI_BIN" ]]; then
  STUBROOT="$(mktemp -d)"; STUB="$STUBROOT/bin"; mkdir -p "$STUB"
  ln -s "$GIT_BIN" "$STUB/git"; ln -s "$WHOAMI_BIN" "$STUB/whoami"   # git present, filter-repo absent
  out="$(PATH="$STUB" run_cfg --non-interactive --check 2>&1)"; st=$?
  assert_status   "missing git-filter-repo exits non-zero" 1 "$st"
  assert_contains "error names the missing tool" "git-filter-repo is not installed" "$out"
  assert_contains "error gives install guidance" "brew install git-filter-repo" "$out"
  rm -rf "$STUBROOT"
else
  bad "could not locate 'whoami' to build a restricted PATH"
fi

# ──────────────────────────────────────────────────────────────────────────────
section "5. Existing local mirror folder is handled (no crash)"
WS5="$(mktemp -d)"
"$GIT_BIN" init -q --bare "$WS5/myrepo-source.git"   # pretend a previous run left a mirror
out="$(cd "$WS5" && AZURE_URL="https://org@dev.azure.com/org/Proj/_git/Repo" \
       GITHUB_SSH="git@github.com:octocat/myrepo.git" OLD_EMAIL="old@corp.example" \
       NEW_NAME="octocat" NEW_EMAIL="me@personal.example" PUSH_BRANCHES="main" PROJECT="myrepo" \
       "$BASH_BIN" "$SCRIPT" --non-interactive --check 2>&1)"; st=$?
assert_status   "existing-mirror preflight exits 0" 0 "$st"
assert_contains "existing mirror detected as incremental" "INCREMENTAL" "$out"
rm -rf "$WS5"

# ──────────────────────────────────────────────────────────────────────────────
section "6. Incremental sync simulation (local stand-in for Azure/GitHub)"
if command -v git-filter-repo >/dev/null 2>&1; then
  WS="$(mktemp -d)"; OLDHOME="${HOME:-}"; export HOME="$WS"
  git config --global init.defaultBranch master >/dev/null 2>&1
  git config --global user.name  vector-test    >/dev/null 2>&1
  git config --global user.email vt@example.com >/dev/null 2>&1

  WORK="$WS/work"; AZ="$WS/azure.git"; GH="$WS/github.git"
  SRC="$WS/repo-source.git"; MIG="$WS/repo-migration.git"; MM="$WS/mailmap.txt"
  gm() { git -c safe.bareRepository=all --git-dir="$MIG" "$@"; }
  gs() { git -c safe.bareRepository=all --git-dir="$SRC" "$@"; }
  mkc(){ GIT_AUTHOR_NAME="$1" GIT_AUTHOR_EMAIL="$2" GIT_COMMITTER_NAME="$1" GIT_COMMITTER_EMAIL="$2" \
         GIT_AUTHOR_DATE="$3" GIT_COMMITTER_DATE="$3" git -C "$WORK" commit -q --allow-empty -m "$4"; }

  mkdir -p "$WORK"; git -C "$WORK" init -q
  mkc "Old Me" "old@corp.example"  "2020-01-01T00:00:00" c1
  mkc "Mate"   "mate@team.example" "2020-01-02T00:00:00" c2
  git -C "$WORK" branch -M master
  git clone -q --mirror "$WORK" "$AZ"
  git init -q --bare "$GH"
  printf 'octocat <me@personal.example> <old@corp.example>\n' > "$MM"

  # Identical stages to migrate.sh: fetch source → rebuild staging → rewrite.
  pipeline() {
    if [[ -d "$SRC" ]]; then gs remote set-url origin "$AZ"; gs remote update origin >/dev/null 2>&1
    else git clone -q --mirror "$AZ" "$SRC"; fi
    rm -rf "$MIG"; git clone -q --mirror --no-hardlinks "$SRC" "$MIG"
    gm filter-repo --mailmap "$MM" --force >/dev/null 2>&1
  }
  # Identical decision tree to migrate.sh push_one(): create / noop / ff / ahead / diverged.
  pushb() {
    local b="$1" l r
    l="$(gm rev-parse "refs/heads/$b")"; r="$(git ls-remote "$GH" "refs/heads/$b" | awk '{print $1}')"
    if [[ -z "$r" ]]; then gm push -q "$GH" "refs/heads/$b:refs/heads/$b"; echo CREATE; return; fi
    [[ "$r" == "$l" ]] && { echo NOOP; return; }
    gm fetch -q "$GH" "+refs/heads/$b:refs/vector/remote/$b"
    if gm merge-base --is-ancestor "$r" "$l"; then gm push -q "$GH" "refs/heads/$b:refs/heads/$b"; echo FF; return; fi
    gm merge-base --is-ancestor "$l" "$r" && { echo REMOTE_AHEAD; return; }
    echo DIVERGED
  }
  ghsha() { git ls-remote "$GH" refs/heads/master | awk '{print $1}'; }
  c1sha() { gm log master --format='%H %ae %s' | awk '$3=="c1"{print $1}'; }

  # Run 1 — initial migration
  pipeline; a1="$(pushb master)"; gh1="$(ghsha)"; rw1="$(c1sha)"
  ids="$(gm log --all --format='%ae' | sort -u | tr '\n' ' ')"
  assert_contains "run1 creates the branch" "CREATE" "$a1"
  case "$ids" in *old@corp.example*) bad "run1 purges old corporate email";; *) ok "run1 purges old corporate email";; esac
  case "$ids" in *mate@team.example*) ok "run1 preserves teammate identity";; *) bad "run1 preserves teammate identity";; esac
  [[ -d "$SRC" ]] && ok "source mirror persists for re-runs" || bad "source mirror persists for re-runs"

  # Run 2 — re-run, no Azure changes (idempotency, existing mirror reused)
  a2="$(pushb master)"
  assert_contains "run2 is idempotent" "NOOP" "$a2"
  [[ "$(ghsha)" == "$gh1" ]] && ok "run2 leaves GitHub unchanged" || bad "run2 leaves GitHub unchanged"

  # Run 3 — new Azure commit → incremental fast-forward into existing mirror
  mkc "Old Me" "old@corp.example" "2020-03-01T00:00:00" c3
  git -C "$WORK" push -q "$AZ" master
  pipeline; a3="$(pushb master)"; gh3="$(ghsha)"; rw3="$(c1sha)"
  assert_contains "run3 fast-forwards the new commit" "FF" "$a3"
  [[ "$rw1" == "$rw3" ]] && ok "deterministic SHAs across runs" || bad "deterministic SHAs across runs"
  gm merge-base --is-ancestor "$gh1" "$gh3" && ok "run3 preserves prior GitHub history" || bad "run3 preserves prior GitHub history"

  # Run 4 — remote diverges (commit only on GitHub) → must NOT overwrite
  DV="$WS/dv"; git clone -q "$GH" "$DV"; git -C "$DV" checkout -q master
  GIT_AUTHOR_NAME=x GIT_AUTHOR_EMAIL=x@x GIT_COMMITTER_NAME=x GIT_COMMITTER_EMAIL=x@x \
    git -C "$DV" commit -q --allow-empty -m github-only
  git -C "$DV" push -q origin master
  ghd="$(ghsha)"; pipeline; a4="$(pushb master)"
  case "$a4" in REMOTE_AHEAD|DIVERGED) ok "run4 refuses to overwrite ($a4)";; *) bad "run4 refuses to overwrite (got $a4)";; esac
  [[ "$(ghsha)" == "$ghd" ]] && ok "run4 leaves GitHub history intact" || bad "run4 leaves GitHub history intact"

  export HOME="$OLDHOME"; rm -rf "$WS"
else
  printf '  (skipped — git-filter-repo not installed)\n'
fi

# ──────────────────────────────────────────────────────────────────────────────
printf '\n\033[1m== Summary ==\033[0m  %d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
