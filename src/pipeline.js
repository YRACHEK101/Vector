// ─────────────────────────────────────────────────────────────────────────────
// pipeline.js — the migration engine: source mirror sync → deterministic rewrite
// staging → mailmap rewrite → ancestry-aware SSH push → verify.
//
// Mirrors the proven shell logic. The push DECISION is a pure function (unit
// tested); the IO steps are integration-tested against local stand-in repos.
// ─────────────────────────────────────────────────────────────────────────────
import { existsSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { run, query, status, gitDir } from './git.js';
import { buildMailmap } from './config.js';
import {
  parseBranchRefs, resolveBranches, parseIdentities,
  detectBranchConflicts, planConflictResolution,
} from './team.js';
import {
  checkGithubSsh, checkAzureSsh, SSH_SETUP_HELP,
  findSshKey, sshKeyGuidance, sshAuthFailureGuidance, listLocalSshKeys,
  isAzureSshUrl, azureSshHost, trustHost,
} from './ssh.js';

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

/**
 * Windows-only, best-effort: make a directory's ref storage case-sensitive so
 * "Mbouzine" and "MBouzine" can coexist as loose refs. fsutil must run on a
 * FRESH (empty) directory before any ref is written, and may fail when the
 * feature is unavailable or needs admin — in which case we fall through and
 * resolve conflicts by rename/skip. Never throws.
 * @returns {{attempted:boolean, ok:boolean, reason?:string}}
 */
export function enableCaseSensitivity(dir, { platform = process.platform, runner } = {}) {
  if (platform !== 'win32') return { attempted: false, ok: false, reason: 'not-windows' };
  try {
    const call = runner || ((cmd, args) => status(cmd, args));
    const code = call('fsutil', ['file', 'setCaseSensitiveInfo', dir, 'enable']);
    return code === 0 ? { attempted: true, ok: true } : { attempted: true, ok: false, reason: `fsutil exited ${code}` };
  } catch (e) {
    return { attempted: true, ok: false, reason: e.message };
  }
}

/** Step 2 — rebuild a fully-isolated rewrite copy from the source (deterministic SHAs). */
export async function buildStaging(cfg, ui = defaultUi, deps = {}) {
  rmSync(cfg.stagingMirror, { recursive: true, force: true });
  // On Windows, make the staging repo's ref storage case-sensitive BEFORE the
  // clone writes any ref, so case-only branch collisions never materialize.
  const platform = deps.platform || process.platform;
  let caseSensitive = { attempted: false };
  if (platform === 'win32') {
    mkdirSync(cfg.stagingMirror, { recursive: true });
    caseSensitive = enableCaseSensitivity(cfg.stagingMirror, deps);
    ui.info(caseSensitive.ok
      ? '  Case-sensitive ref storage enabled for the staging copy.'
      : `  Case-sensitive ref storage unavailable (${caseSensitive.reason}); will resolve any conflicts by rename/skip.`);
  }
  const sp = ui.spinner('Building isolated rewrite staging copy').start();
  await run('git', ['clone', '--mirror', '--no-hardlinks', cfg.sourceMirror, cfg.stagingMirror], { env: cfg.gitEnv });
  sp.succeed('Staging copy ready');
  return { caseSensitive };
}

/**
 * Step 2.5 — detect branch-name conflicts that break git-filter-repo on
 * case-insensitive filesystems and resolve them BEFORE the rewrite. The strategy
 * comes from cfg._resolveConflicts (interactive); non-interactively we default to
 * the safe, data-preserving choice: rename. Returns a report of what was done.
 */
export async function resolveBranchConflicts(cfg, ui = defaultUi) {
  const dir = cfg.stagingMirror;
  let branches = listBranches(cfg, dir);
  const conflicts = detectBranchConflicts(branches);
  if (!conflicts.length) return { conflicts: [], renames: [], skipped: [], strategy: 'none' };

  ui.warn(`Detected ${conflicts.length} branch-name conflict(s) that break on case-insensitive (Windows) filesystems:`);
  for (const cf of conflicts) {
    ui.warn(`  • ${cf.type === 'case' ? 'case-only' : 'directory/file'} conflict: "${cf.a}" vs "${cf.b}"`);
  }

  // Choose a strategy: interactive resolver if one was injected, else default rename.
  const strategy = cfg._resolveConflicts ? await cfg._resolveConflicts(conflicts) : 'rename';
  if (strategy === 'abort') {
    throw new Error(
      'Aborted on branch-name conflicts. Options:\n' +
      '  - Re-run on Linux/WSL (a case-sensitive filesystem resolves these natively), or\n' +
      '  - Migrate fewer branches with --branch <name> to exclude the conflicting ones.',
    );
  }

  const plan = planConflictResolution(branches, strategy);
  if (strategy === 'skip') {
    for (const b of plan.skipped) {
      const sha = query('git', [...gitDir(dir), 'rev-parse', `refs/heads/${b}`]);
      if (sha) await run('git', [...gitDir(dir), 'update-ref', '-d', `refs/heads/${b}`, sha], { env: cfg.gitEnv }).catch(noop);
      ui.warn(`  [${b}] skipped — not migrated (conflicting branch).`);
    }
  } else {
    for (const { from, to } of plan.renames) {
      const sha = query('git', [...gitDir(dir), 'rev-parse', `refs/heads/${from}`]);
      if (!sha) continue;
      await run('git', [...gitDir(dir), 'update-ref', `refs/heads/${to}`, sha], { env: cfg.gitEnv });
      await run('git', [...gitDir(dir), 'update-ref', '-d', `refs/heads/${from}`, sha], { env: cfg.gitEnv });
      ui.ok(`  [${from}] → [${to}] (renamed to avoid the conflict; branch still migrates).`);
    }
  }

  branches = listBranches(cfg, dir);
  if (detectBranchConflicts(branches).length) {
    ui.warn('  Some conflicts remain after resolution; the rewrite may still fail on this filesystem.');
  }
  return { conflicts: plan.conflicts, renames: plan.renames, skipped: plan.skipped, strategy };
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
  try {
    await run('git', [...gitDir(cfg.stagingMirror), 'filter-repo', '--mailmap', cfg.mailmapFile, '--force'], { env: cfg.gitEnv });
  } catch (e) {
    sp.fail('History rewrite failed');
    const detail = `${e.message || ''}\n${e.stderr || ''}`;
    if (/cannot lock ref|reference already exists|already exists/i.test(detail)) {
      throw new Error(
        'git-filter-repo hit a branch-name conflict on this filesystem — two branches that ' +
        'differ only in case, or a name that is also a path-prefix of another (e.g. "MBouzine" ' +
        'and "MBouzine/init_repo").\n' +
        'Vector resolves this automatically: re-run and choose Rename (default) or Skip at the ' +
        'prompt, run on Linux/WSL, or narrow the set with --branch <name>.',
      );
    }
    throw e;
  }
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

/**
 * v2 — the full SSH preflight, run BEFORE any mirror/rewrite/push work:
 *   1. a usable SSH key must exist locally (else print OS-specific ssh-keygen
 *      guidance and STOP, so we never clone for minutes then fail at the push);
 *   2. trust the relevant host keys non-interactively (github.com always when
 *      the destination is GitHub SSH; the Azure SSH host only when the SOURCE
 *      url is SSH);
 *   3. verify auth: GitHub for the push, Azure only when its url is SSH. An
 *      HTTPS Azure url skips every Azure SSH check.
 * All IO (key lookup, host trust, both checkers) is injectable via `deps`/cfg for
 * offline tests. Returns `{ok, skipped?}` and throws with an exact fix otherwise.
 */
export async function ensureSshReady(cfg, ui = defaultUi, deps = {}) {
  if (cfg.skipSshPreflight) return { ok: true, skipped: true };
  const platform = deps.platform || process.platform;
  const fileExists = deps.fileExists || existsSync;

  // An explicit --ssh-key, when given, must exist; we then force ONLY it (so the
  // probe matches the push, which already pins it via gitEnv's -i/IdentitiesOnly).
  const explicitKey = cfg.sshKey || '';
  if (explicitKey && !fileExists(explicitKey)) {
    throw new Error(`--ssh-key path not found: ${explicitKey}`);
  }

  // 1. Is there ANY usable key — explicit, on disk, or in the agent? If none, the
  //    only fix is to generate one: show OS-specific guidance and stop before the
  //    clone. We do NOT pin to a single identity; ssh will try them all below.
  const any = (deps.findSshKey || findSshKey)({ explicitKey });
  if (!any.found) throw new Error(sshKeyGuidance({ platform }));
  if (explicitKey) ui.ok(`Using the SSH key passed with --ssh-key: ${explicitKey}`);
  else ui.ok('SSH key(s) found — verifying against all local keys and the ssh-agent.');

  const needGithub = isGithubSshUrl(cfg.githubSsh); // destination push is over SSH
  const needAzure = isAzureSshUrl(cfg.azureUrl);    // source url is SSH (else HTTPS → skip)

  // 2. Trust host keys (best-effort; accept-new in gitEnv is the real safety net).
  const trust = deps.trustHost || trustHost;
  if (needGithub) trust('github.com', deps);
  if (needAzure) trust(azureSshHost(cfg.azureUrl), deps);

  const keyPath = explicitKey || undefined; // undefined → ssh offers agent + all keys
  const listKeys = deps.listLocalSshKeys || listLocalSshKeys;

  // 3a. GitHub auth — always required for the push. Fails only if NO key authenticates;
  //     the message then names every local key and exactly where to register one.
  if (needGithub) {
    const check = deps.githubCheck || cfg._sshCheck || checkGithubSsh;
    const res = await check({ env: cfg.gitEnv, keyPath });
    if (!res.ok) {
      throw new Error(sshAuthFailureGuidance({ platform, keys: listKeys({}), service: 'github', reason: res.reason }));
    }
    ui.ok(`GitHub SSH OK — authenticated as ${res.user || 'your account'}.`);
  }

  // 3b. Azure auth — only when the source is SSH; HTTPS sources need no Azure key.
  if (needAzure) {
    const host = azureSshHost(cfg.azureUrl);
    const check = deps.azureCheck || cfg._azureSshCheck || checkAzureSsh;
    const res = await check({ env: cfg.gitEnv, host, keyPath });
    if (!res.ok) {
      throw new Error(sshAuthFailureGuidance({ platform, keys: listKeys({}), service: 'azure', reason: res.reason }));
    }
    ui.ok(`Azure DevOps SSH OK${res.user ? ` — ${res.user}` : ''}.`);
  } else if (cfg.azureUrl) {
    ui.info('Azure source is HTTPS — skipping Azure SSH checks (only GitHub SSH is needed).');
  }

  return { ok: true, needGithub, needAzure };
}

/** Full pipeline: idempotent, incremental, non-destructive. */
export async function migrate(cfg, ui = defaultUi) {
  await ensureGithubSsh(cfg, ui); // stop early if SSH isn't set up — never push-fail late
  const sync = await syncSourceMirror(cfg, ui);
  const staging = await buildStaging(cfg, ui);
  // Resolve case-insensitive / directory-file branch conflicts before the rewrite,
  // so git-filter-repo can't crash with "cannot lock ref" on Windows/macOS.
  const conflicts = await resolveBranchConflicts(cfg, ui);
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
  return { mode: sync.mode, rewrite, conflicts, caseSensitive: staging.caseSensitive, branches, pushes, verification: verify(cfg, branches) };
}
