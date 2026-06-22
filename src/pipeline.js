// ─────────────────────────────────────────────────────────────────────────────
// pipeline.js — the migration engine: source mirror sync → deterministic rewrite
// staging → mailmap rewrite → ancestry-aware SSH push → verify.
//
// Mirrors the proven shell logic. The push DECISION is a pure function (unit
// tested); the IO steps are integration-tested against local stand-in repos.
// ─────────────────────────────────────────────────────────────────────────────
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import { run, query, status, gitDir } from './git.js';
import { buildMailmap } from './config.js';
import { parseBranchRefs, resolveBranches, parseIdentities } from './team.js';
import { checkGithubSsh, SSH_SETUP_HELP } from './ssh.js';

const noop = () => {};
const defaultUi = { step: noop, info: noop, ok: noop, warn: noop, spinner: () => ({ start() { return this; }, succeed() { return this; }, fail() { return this; }, stop() { return this; } }) };

/**
 * Pure decision for how to push a branch given the local & remote tip SHAs and an
 * ancestry oracle. This is the heart of the non-destructive guarantee.
 *   missing-local | create | noop | fast-forward | remote-ahead | diverged
 */
export function decidePushStrategy({ localSha, remoteSha, isAncestor }) {
  if (!localSha) return 'missing-local';
  if (!remoteSha) return 'create';
  if (remoteSha === localSha) return 'noop';
  if (isAncestor(remoteSha, localSha)) return 'fast-forward'; // remote behind → safe FF
  if (isAncestor(localSha, remoteSha)) return 'remote-ahead'; // remote ahead → never overwrite
  return 'diverged';                                          // only force after confirm
}

/** Step 1 — keep a pristine source mirror, fetching new commits into it (never rewriting it). */
export async function syncSourceMirror(cfg, ui = defaultUi) {
  if (existsSync(cfg.sourceMirror)) {
    const sp = ui.spinner('Fetching new commits from Azure into existing mirror').start();
    await run('git', [...gitDir(cfg.sourceMirror), 'remote', 'set-url', 'origin', cfg.azureUrl], { env: cfg.gitEnv }).catch(noop);
    await run('git', [...gitDir(cfg.sourceMirror), 'remote', 'update', 'origin'], { env: cfg.gitEnv });
    sp.succeed('Source mirror updated');
    return { mode: 'incremental' };
  }
  const sp = ui.spinner('Mirror-cloning the Azure repository (full history)').start();
  await run('git', ['clone', '--mirror', cfg.azureUrl, cfg.sourceMirror], { env: cfg.gitEnv });
  sp.succeed('Source mirror created');
  return { mode: 'initial' };
}

/** Step 2 — rebuild a fully-isolated rewrite copy from the source (deterministic SHAs). */
export async function buildStaging(cfg, ui = defaultUi) {
  rmSync(cfg.stagingMirror, { recursive: true, force: true });
  const sp = ui.spinner('Building isolated rewrite staging copy').start();
  await run('git', ['clone', '--mirror', '--no-hardlinks', cfg.sourceMirror, cfg.stagingMirror], { env: cfg.gitEnv });
  sp.succeed('Staging copy ready');
}

/** Are any of the given emails still present anywhere in the staging history (author or committer)? */
export function emailsPresent(cfg, emails) {
  if (!emails || !emails.length) return false;
  const out = query('git', [...gitDir(cfg.stagingMirror), 'log', '--all', '--format=%ae%n%ce']) || '';
  const have = new Set(out.split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean));
  return emails.some((e) => have.has(String(e).toLowerCase()));
}

/** Back-compat helper: are any of the personal-mode old emails present? */
export const oldEmailsPresent = (cfg) => emailsPresent(cfg, cfg.allOldEmails);

/**
 * Step 3 — write the effective mailmap and rewrite history. Works for both modes:
 * personal (single identity) and team (multi-developer mailmap). Skips only when we
 * can prove there's nothing to do; the rewrite itself is deterministic either way.
 */
export async function rewriteHistory(cfg, ui = defaultUi) {
  const text = cfg.mailmapText ?? buildMailmap(cfg.newName, cfg.newEmail, cfg.allOldEmails);
  writeFileSync(cfg.mailmapFile, text);
  if (!text.trim()) {
    ui.ok('No identity mappings provided — skipping rewrite.');
    return { rewritten: false };
  }
  const emails = cfg.rewriteEmails ?? cfg.allOldEmails ?? [];
  const hasNameOnly = !!cfg.hasNameOnlyMapping;
  if (!emailsPresent(cfg, emails) && !hasNameOnly) {
    ui.ok('No matching identities in history — already rewritten, skipping.');
    return { rewritten: false };
  }
  const sp = ui.spinner('Rewriting author/committer identities via git-filter-repo').start();
  await run('git', [...gitDir(cfg.stagingMirror), 'filter-repo', '--mailmap', cfg.mailmapFile, '--force'], { env: cfg.gitEnv });
  sp.succeed('History rewritten');
  if (emails.length && emailsPresent(cfg, emails)) {
    throw new Error('Safety check failed: a mapped old email still remains in history after the rewrite. Aborting before push.');
  }
  return { rewritten: true };
}

/** Enumerate the branches present in a mirror (defaults to the staging mirror). */
export function listBranches(cfg, dir = cfg.stagingMirror) {
  const out = query('git', [...gitDir(dir), 'for-each-ref', '--format=%(refname:short)', 'refs/heads/']) || '';
  return parseBranchRefs(out);
}

/** Enumerate the unique author identities across all refs of a mirror (defaults to source). */
export function listAuthors(cfg, dir = cfg.sourceMirror) {
  const out = query('git', [...gitDir(dir), 'log', '--all', '--pretty=format:%aN|%aE']) || '';
  return parseIdentities(out);
}

/** Step 4 — push one branch using the only safe strategy for its remote relationship. */
export async function pushBranch(cfg, branch, ui = defaultUi) {
  const gd = gitDir(cfg.stagingMirror);
  const localSha = query('git', [...gd, 'rev-parse', `refs/heads/${branch}`]);
  if (!localSha) {
    ui.warn(`[${branch}] not found in source — skipping.`);
    return { branch, strategy: 'missing-local' };
  }

  const ls = query('git', [...gd, 'ls-remote', cfg.githubSsh, `refs/heads/${branch}`], { env: cfg.gitEnv });
  const remoteSha = ls ? ls.split(/\s+/)[0] : '';

  // Pull the remote tip into a private scratch ref so ancestry checks are local.
  if (remoteSha && remoteSha !== localSha) {
    await run('git', [...gd, 'fetch', cfg.githubSsh, `+refs/heads/${branch}:refs/vector/remote/${branch}`], { env: cfg.gitEnv }).catch(noop);
  }
  const isAncestor = (a, b) => status('git', [...gd, 'merge-base', '--is-ancestor', a, b]) === 0;
  const strategy = decidePushStrategy({ localSha, remoteSha, isAncestor });

  const doPush = (force = false) =>
    run('git', [...gd, 'push', ...(force ? ['--force'] : []), cfg.githubSsh, `refs/heads/${branch}:refs/heads/${branch}`], { env: cfg.gitEnv });

  switch (strategy) {
    case 'create':
      await doPush(); ui.ok(`[${branch}] created on GitHub (new branch).`); break;
    case 'noop':
      ui.ok(`[${branch}] already up to date — nothing to push.`); break;
    case 'fast-forward': {
      const ahead = query('git', [...gd, 'rev-list', '--count', `${remoteSha}..${localSha}`]) || '?';
      await doPush(); ui.ok(`[${branch}] fast-forwarded (+${ahead} commit(s)) — existing history preserved.`); break;
    }
    case 'remote-ahead':
      ui.warn(`[${branch}] remote is AHEAD — skipping to protect GitHub history.`); break;
    case 'diverged':
      if (cfg.force) { await doPush(true); ui.warn(`[${branch}] force-pushed (divergence resolved).`); }
      else ui.warn(`[${branch}] histories DIVERGED — skipped. Re-run with --force to overwrite.`);
      break;
  }
  return { branch, strategy, localSha, remoteSha };
}

/** Step 5 — confirm each branch's remote tip matches local where we pushed. */
export function verify(cfg, branches = cfg.branches) {
  const gd = gitDir(cfg.stagingMirror);
  return branches.map((branch) => {
    const localSha = query('git', [...gd, 'rev-parse', `refs/heads/${branch}`]);
    if (!localSha) return { branch, status: 'missing-local' };
    const ls = query('git', [...gd, 'ls-remote', cfg.githubSsh, `refs/heads/${branch}`], { env: cfg.gitEnv });
    const remoteSha = ls ? ls.split(/\s+/)[0] : '';
    return { branch, status: remoteSha === localSha ? 'in-sync' : (remoteSha ? 'differs' : 'absent'), localSha, remoteSha };
  });
}

/** Does the destination point at GitHub over SSH (so the SSH preflight applies)? */
export function isGithubSshUrl(url = '') {
  return /^(git@github\.com:|ssh:\/\/git@github\.com\/)/i.test(String(url));
}

/**
 * Fail-fast GitHub SSH preflight, run before any mirror/rewrite/push work. Skips
 * non-GitHub-SSH targets (e.g. the local stand-in repos used in tests) and when
 * explicitly disabled. The checker is injectable via cfg._sshCheck for offline tests.
 * @returns {Promise<{ok:boolean, user?:string, reason?:string, skipped?:boolean}>}
 */
export async function ensureGithubSsh(cfg, ui = defaultUi) {
  if (cfg.skipSshPreflight) return { ok: true, skipped: true };
  if (!isGithubSshUrl(cfg.githubSsh)) return { ok: true, skipped: true };
  const check = cfg._sshCheck || checkGithubSsh;
  const res = await check({ env: cfg.gitEnv });
  if (!res.ok) {
    throw new Error(`GitHub SSH preflight failed: ${res.reason}\n\n${SSH_SETUP_HELP}`);
  }
  ui.ok(`GitHub SSH OK — authenticated as ${res.user || 'your account'}.`);
  return res;
}

/** Full pipeline: idempotent, incremental, non-destructive. */
export async function migrate(cfg, ui = defaultUi) {
  await ensureGithubSsh(cfg, ui); // stop early if SSH isn't set up — never push-fail late
  const sync = await syncSourceMirror(cfg, ui);
  await buildStaging(cfg, ui);
  const rewrite = await rewriteHistory(cfg, ui);
  // Resolve the branch set after the mirror exists. Default = every branch;
  // an explicit --branch list narrows it; --all-branches forces all.
  const branches = resolveBranches({
    explicit: cfg.branchesExplicit ? cfg.branches : [],
    allBranches: !!cfg.allBranches,
    available: listBranches(cfg),
  });
  const pushes = [];
  for (const branch of branches) pushes.push(await pushBranch(cfg, branch, ui));
  return { mode: sync.mode, rewrite, branches, pushes, verification: verify(cfg, branches) };
}
