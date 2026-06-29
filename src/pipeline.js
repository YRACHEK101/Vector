// ─────────────────────────────────────────────────────────────────────────────
// pipeline.js — the migration engine: source mirror sync → deterministic rewrite
// staging → mailmap rewrite → ancestry-aware SSH push → verify.
//
// Mirrors the proven shell logic. The push DECISION is a pure function (unit
// tested); the IO steps are integration-tested against local stand-in repos.
// ─────────────────────────────────────────────────────────────────────────────
import { existsSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import {
  run, query, status, gitDir,
  refTips, remoteRefTips, countReachable,
} from './git.js';
import { buildMailmap, decideRewriteStrategy, DEFAULT_MAX_FILE_MB, EXIT, VectorError } from './config.js';
import { compareIntegrity, formatIntegrityReport } from './integrity.js';
import {
  scanLargeBlobs, mbToBytes, formatBytes, formatOffenders, defaultLargeFileAction,
  gitLfsAvailable, suggestGitignore, parseGH001, formatGH001Guidance, LFS_INSTALL_HELP,
} from './largefiles.js';
import {
  parseBranchRefs, resolveBranches, parseIdentities, parseMailmap,
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
  if (cfg.workDir) mkdirSync(cfg.workDir, { recursive: true });
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
  if (cfg.workDir) mkdirSync(cfg.workDir, { recursive: true });
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

  const conflictLabel = (type) =>
    (type === 'case' ? 'case-only'
      : type === 'case-dir' ? 'directory case'
        : 'directory/file');
  ui.warn(`Detected ${conflicts.length} branch-name conflict(s) that break on case-insensitive (Windows/macOS) filesystems:`);
  for (const cf of conflicts) {
    ui.warn(`  • ${conflictLabel(cf.type)} conflict: "${cf.a}" vs "${cf.b}"`);
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
      const create = () => run('git', [...gitDir(dir), 'update-ref', `refs/heads/${to}`, sha], { env: cfg.gitEnv });
      const remove = () => run('git', [...gitDir(dir), 'update-ref', '-d', `refs/heads/${from}`, sha], { env: cfg.gitEnv });
      // A pure case re-spelling (e.g. "yrachek/E2E-test" → "yRachek/E2E-test")
      // aliases the old and new names on a case-insensitive FS, so creating first
      // would let the delete remove the freshly-written ref. Remove the old ref
      // FIRST in that case; for a genuinely distinct "-N" name, create first so the
      // branch is never momentarily absent.
      if (lc(from) === lc(to)) { await remove(); await create(); }
      else { await create(); await remove(); }
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

const lc = (s) => String(s ?? '').toLowerCase();

/** Unique author + committer (name,email) identities across all refs of the staging mirror. */
function historyIdentities(cfg) {
  const a = query('git', [...gitDir(cfg.stagingMirror), 'log', '--all', '--format=%aN|%aE']) || '';
  const c = query('git', [...gitDir(cfg.stagingMirror), 'log', '--all', '--format=%cN|%cE']) || '';
  return parseIdentities(`${a}\n${c}`);
}

/**
 * Pure: would ANY mapping actually change something given the identities present?
 * (email change → its old email present · targeted name → that name+email present ·
 * full name normalization → a non-canonical name exists for that email).
 */
export function mappingsApplicable(ids, entries) {
  return (entries || []).some((e) => {
    if (lc(e.sourceEmail) !== lc(e.email)) return ids.some((id) => lc(id.email) === lc(e.sourceEmail));
    if (e.sourceName) return ids.some((id) => lc(id.email) === lc(e.email) && lc(id.name) === lc(e.sourceName));
    return ids.some((id) => lc(id.email) === lc(e.email) && lc(id.name) !== lc(e.name));
  });
}

/**
 * Pure: per-mapping post-rewrite validation. Each entry asserts ONLY what it
 * intended to change — never failing because a new/canonical identity legitimately
 * exists. Returns an array of human-readable error strings (empty = all good).
 *   email changed              → the OLD email must be gone;
 *   name only, targeted source → that (old name, email) pair must be gone;
 *   name only, full normalize  → every name for that email is now the canonical name.
 * @param {Array<{name,email}>} ids identities present AFTER the rewrite
 * @param {Array<{name,email,sourceName?,sourceEmail}>} entries mailmap entries
 */
export function validateMappings(ids, entries) {
  const errors = [];
  for (const e of entries || []) {
    if (lc(e.sourceEmail) !== lc(e.email)) {
      if (ids.some((id) => lc(id.email) === lc(e.sourceEmail))) {
        errors.push(`old email <${e.sourceEmail}> still present after rewrite (its commits were not remapped to "${e.name}" <${e.email}>)`);
      }
    } else if (e.sourceName) {
      if (ids.some((id) => lc(id.email) === lc(e.email) && lc(id.name) === lc(e.sourceName))) {
        errors.push(`"${e.sourceName}" <${e.email}> still present after rewrite (not unified to "${e.name}")`);
      }
    } else {
      const stray = [...new Set(ids
        .filter((id) => lc(id.email) === lc(e.email) && lc(id.name) !== lc(e.name))
        .map((id) => id.name))];
      if (stray.length) {
        const pairs = stray.map((n) => `"${n}" <${e.email}>`).join(', ');
        errors.push(`not unified to "${e.name}" <${e.email}>: ${pairs}`);
      }
    }
  }
  return errors;
}

/**
 * Step 3 — write the effective mailmap and rewrite history. Works for both modes:
 * personal (single identity) and team (multi-developer mailmap). Skips only when we
 * can prove there's nothing to do; the rewrite itself is deterministic either way.
 */
export async function rewriteHistory(cfg, ui = defaultUi, opts = {}) {
  // When set, fold an oversized-blob strip into THIS same git-filter-repo pass
  // (one rewrite, not two). Only reached when there are real mappings to apply —
  // migrate() guarantees that before passing a strip threshold here.
  const stripMb = opts.stripBlobsBiggerThanMB || null;
  const text = cfg.mailmapText ?? buildMailmap(cfg.newName, cfg.newEmail, cfg.allOldEmails);
  writeFileSync(cfg.mailmapFile, text);
  if (!text.trim()) {
    ui.ok('No identity mappings provided — skipping rewrite.');
    return { rewritten: false };
  }
  const entries = parseMailmap(text);
  // Nothing to do if none of the mappings' SOURCE identities are present here
  // (e.g. a team mailmap re-run, or a mapping for emails not in this repo).
  if (!mappingsApplicable(historyIdentities(cfg), entries)) {
    ui.ok('No matching identities in history — nothing to remap, skipping.');
    return { rewritten: false };
  }
  const sp = ui.spinner(stripMb
    ? 'Rewriting identities and stripping oversized files via git-filter-repo'
    : 'Rewriting author/committer identities via git-filter-repo').start();
  try {
    const args = [...gitDir(cfg.stagingMirror), 'filter-repo', '--mailmap', cfg.mailmapFile];
    if (stripMb) args.push('--strip-blobs-bigger-than', `${stripMb}M`);
    args.push('--force');
    await run('git', args, { env: cfg.gitEnv });
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
  sp.succeed(stripMb ? 'History rewritten (identities remapped, oversized files stripped)' : 'History rewritten');
  // Per-mapping safety check: validate exactly what each mapping intended to change.
  // A name-only remap keeps its email on purpose, so we do NOT require it to vanish.
  const errors = validateMappings(historyIdentities(cfg), entries);
  if (errors.length) {
    throw new Error(`Safety check failed after the rewrite:\n  - ${errors.join('\n  - ')}\nAborting before push.`);
  }
  return { rewritten: true, stripped: !!stripMb };
}

/** Is git-lfs usable? Honors an injected cfg._lfsAvailable (tests), else probes. */
function lfsOk(cfg) {
  return typeof cfg._lfsAvailable === 'boolean' ? cfg._lfsAvailable : gitLfsAvailable();
}

/** Run a targeted git-filter-repo pass that strips every blob bigger than `mb` MiB. */
export async function stripLargeBlobs(cfg, mb) {
  await run('git', [...gitDir(cfg.stagingMirror), 'filter-repo', '--strip-blobs-bigger-than', `${mb}M`, '--force'], { env: cfg.gitEnv });
}

/** Move every blob bigger than `mb` MiB into Git LFS (rewrites history to pointers). */
export async function lfsMigrateImport(cfg, mb) {
  // `git lfs migrate` runs against the repo selected by -C; our staging is a bare
  // mirror, so we must also trust it (safe.bareRepository=all) — which propagates
  // to the child git processes git-lfs spawns via GIT_CONFIG_PARAMETERS.
  await run('git', ['-c', 'safe.bareRepository=all', '-C', cfg.stagingMirror, 'lfs', 'migrate', 'import', `--above=${mb}MiB`, '--everything'], { env: cfg.gitEnv });
}

/**
 * Pre-flight (Step 2.7): scan the staging history for blobs over the size limit,
 * REPORT each offender (path + human size) before any push, and decide how to
 * remediate. Runs before the rewrite so a strip can ride along in the same
 * git-filter-repo pass. Throws (exit 3) when the chosen action is `abort`.
 * @returns {Promise<{offenders:Array,action:string,limitMb:number,limitBytes:number}>}
 */
export async function planLargeFileRemediation(cfg, ui = defaultUi) {
  const limitMb = cfg.maxFileSizeMb || DEFAULT_MAX_FILE_MB;
  const limitBytes = mbToBytes(limitMb);
  if (cfg.skipLargeFileScan) return { offenders: [], action: 'none', limitMb, limitBytes };

  const sp = ui.spinner(`Scanning history for files larger than ${limitMb} MB`).start();
  let offenders = [];
  try { offenders = await scanLargeBlobs(cfg.stagingMirror, limitBytes, { env: cfg.gitEnv }); } catch { offenders = []; }
  if (!offenders.length) {
    sp.succeed(`No files exceed the ${limitMb} MB limit.`);
    return { offenders: [], action: 'none', limitMb, limitBytes };
  }
  sp.stop();
  ui.warn(formatOffenders(offenders, limitMb));

  // Resolve the action: explicit flag wins; otherwise prompt (interactive) or
  // default to strip (non-interactive / --force / CI — "just fix it and push").
  let action = defaultLargeFileAction({ requested: cfg.onLargeFile, hasPrompter: !!cfg._chooseLargeFileAction });
  if (action === 'prompt') action = await cfg._chooseLargeFileAction(offenders, { lfsAvailable: lfsOk(cfg) });

  if (action === 'abort') {
    throw new VectorError(
      `Aborting: ${offenders.length} file(s) exceed GitHub's ${limitMb} MB limit:\n`
      + offenders.map((o) => `  • ${o.path} (${formatBytes(o.size)})`).join('\n') + '\n'
      + 'Re-run with --on-large-file strip to remove them from history (default with --force), '
      + '--on-large-file lfs to move them to Git LFS, or raise --max-file-size.',
      EXIT.GIT,
    );
  }
  // Loud warning when an auto-default (no flag, no prompt) silently rewrites history.
  if (!cfg.onLargeFile && !cfg._chooseLargeFileAction) {
    ui.warn(`No prompt available (non-interactive/--force) — defaulting to "${action}", which rewrites history. `
      + 'Use --on-large-file abort to stop instead, or --on-large-file lfs to keep them in Git LFS.');
  }
  return { offenders, action, limitMb, limitBytes };
}

/**
 * Apply the remediation chosen by planLargeFileRemediation. A `strip` already
 * folded into the identity-rewrite pass needs no extra work here (folded=true);
 * otherwise this runs the targeted strip / LFS pass. Always re-scans and logs
 * honestly that history changed and clones must be refreshed.
 */
export async function applyLargeFileRemediation(cfg, ui = defaultUi, plan = {}, { folded = false } = {}) {
  const { offenders = [], action = 'none', limitMb, limitBytes } = plan;
  if (!offenders.length || action === 'none' || action === 'abort') return { remediated: false };

  // Dry-run rewrites nothing (no push will follow) — just report the plan.
  if (cfg.dryRun) {
    ui.warn(`Dry-run — would ${action === 'lfs' ? 'move to Git LFS' : 'strip from history'}: ${offenders.map((o) => o.path).join(', ')}`);
    return { remediated: false, planned: action };
  }

  let mode = action;
  if (mode === 'lfs' && !lfsOk(cfg)) {
    ui.warn('git-lfs is not installed — cannot move large files to Git LFS.');
    for (const line of LFS_INSTALL_HELP.split('\n')) ui.warn(`  ${line}`);
    // Sensible fallback: an auto/non-interactive run "just fixes it" by stripping;
    // an interactive run that explicitly chose LFS stops so the user can decide.
    if (cfg._chooseLargeFileAction && !cfg.force) {
      throw new VectorError('Aborting: --on-large-file lfs needs git-lfs. Install it, or re-run with --on-large-file strip.', EXIT.GIT);
    }
    ui.warn('Falling back to stripping the file(s) from history.');
    mode = 'strip';
  }

  if (mode === 'strip') {
    if (folded) {
      ui.ok('Oversized files stripped in the same git-filter-repo pass as the identity rewrite.');
    } else {
      const sp = ui.spinner(`Stripping ${offenders.length} oversized file(s) from all history via git-filter-repo`).start();
      try { await stripLargeBlobs(cfg, limitMb); } catch (e) { sp.fail('Strip failed'); throw e; }
      sp.succeed('Oversized files stripped from history');
    }
  } else { // lfs
    const sp = ui.spinner('Moving oversized files to Git LFS via git lfs migrate').start();
    try { await lfsMigrateImport(cfg, limitMb); } catch (e) { sp.fail('LFS migration failed'); throw e; }
    sp.succeed('Oversized files moved to Git LFS');
  }

  // Honest logging: history changed, SHAs changed, clones must be refreshed.
  let remaining = [];
  try { remaining = await scanLargeBlobs(cfg.stagingMirror, limitBytes, { env: cfg.gitEnv }); } catch { remaining = []; }
  ui.warn(`History was rewritten — ${offenders.length} oversized file(s) ${mode === 'lfs' ? 'moved to Git LFS' : 'removed from every commit'}:`);
  for (const o of offenders) ui.warn(`  • ${o.path} (${formatBytes(o.size)})`);
  ui.warn('  Commit SHAs changed. Anyone with an existing clone of the destination must re-clone.');
  const ignores = suggestGitignore(offenders);
  if (ignores.length) ui.info(`  Tip: add to .gitignore so these don't return on the next migration: ${ignores.join(', ')}`);
  if (remaining.length) ui.warn(`  ${remaining.length} file(s) still exceed the ${limitMb} MB limit after remediation.`);
  return { remediated: true, mode, removed: offenders, remaining };
}

/** Enumerate the branches present in a mirror (defaults to the staging mirror). */
export function listBranches(cfg, dir = cfg.stagingMirror) {
  const out = query('git', [...gitDir(dir), 'for-each-ref', '--format=%(refname:short)', 'refs/heads/']) || '';
  return parseBranchRefs(out);
}

/** Enumerate the tags present in the staging mirror (short names). */
export function listTags(cfg, dir = cfg.stagingMirror) {
  const out = query('git', [...gitDir(dir), 'for-each-ref', '--format=%(refname:short)', 'refs/tags/']) || '';
  return parseBranchRefs(out);
}

/**
 * Push one tag. New tags are created; a tag whose object changed (e.g. a rewrite
 * moved it) is updated with a precise --force-with-lease (never a bare --force),
 * so we only overwrite the exact remote value we observed.
 */
export async function pushTag(cfg, tag, ui = defaultUi) {
  const gd = gitDir(cfg.stagingMirror);
  const localSha = query('git', [...gd, 'rev-parse', `refs/tags/${tag}`]);
  if (!localSha) return { tag, strategy: 'missing-local' };
  const ls = query('git', [...gd, 'ls-remote', cfg.githubSsh, `refs/tags/${tag}`], { env: cfg.gitEnv });
  const remoteSha = ls ? ls.split(/\s+/)[0] : '';
  const refspec = `refs/tags/${tag}:refs/tags/${tag}`;
  if (remoteSha === localSha) return { tag, strategy: 'noop', localSha, remoteSha };
  if (cfg.dryRun) {
    ui.info(`  [tag ${tag}] would ${remoteSha ? 'update' : 'create'} (dry-run — no push).`);
    return { tag, strategy: remoteSha ? 'update' : 'create', planned: true, localSha, remoteSha };
  }
  if (!remoteSha) {
    await run('git', [...gd, 'push', cfg.githubSsh, refspec], { env: cfg.gitEnv, capture: true, tee: true });
    ui.ok(`  [tag ${tag}] created on the destination.`);
    return { tag, strategy: 'create', localSha, remoteSha };
  }
  await run('git', [...gd, 'push', `--force-with-lease=refs/tags/${tag}:${remoteSha}`, cfg.githubSsh, refspec], { env: cfg.gitEnv, capture: true, tee: true });
  ui.warn(`  [tag ${tag}] updated on the destination (its object changed — likely the identity rewrite).`);
  return { tag, strategy: 'update', localSha, remoteSha };
}

/**
 * Post-push integrity verdict: compare the migrated staging mirror (A) against the
 * destination remote (B) over the refs we actually synced — every branch we pushed
 * or that was already in sync, plus every tag we pushed. Branches deliberately left
 * untouched (remote-ahead / diverged-and-skipped) are excluded, since the remote
 * legitimately differs there. Verifies ref set, tip OIDs, and reachable count.
 */
export function verifyIntegrity(cfg, { pushes = [], tagPushes = [] } = {}) {
  const sTips = refTips(cfg.stagingMirror);
  const rTips = remoteRefTips(cfg.githubSsh, { env: cfg.gitEnv });
  const synced = new Set();
  for (const p of pushes) {
    if (p.strategy === 'create' || p.strategy === 'noop' || p.strategy === 'fast-forward'
      || (p.strategy === 'diverged' && p.forced)) synced.add(`refs/heads/${p.branch}`);
  }
  for (const t of tagPushes) {
    if (t.strategy === 'create' || t.strategy === 'noop' || t.strategy === 'update') synced.add(`refs/tags/${t.tag}`);
  }
  const aRefs = {};
  const bRefs = {};
  for (const ref of synced) {
    if (sTips[ref]) aRefs[ref] = sTips[ref];
    if (rTips[ref]) bRefs[ref] = rTips[ref];
  }
  const aCount = countReachable(cfg.stagingMirror, Object.values(aRefs));
  const bCount = countReachable(cfg.stagingMirror, Object.values(bRefs));
  return compareIntegrity({ aRefs, bRefs, aCount, bCount, aLabel: 'staging', bLabel: 'destination' });
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

  // --dry-run: report the plan, write nothing to the remote.
  if (cfg.dryRun) {
    ui.info(`  [${branch}] would ${strategy} (dry-run — no push).`);
    return { branch, strategy, planned: true, localSha, remoteSha };
  }

  // On --sync, a TRUE divergence (unrelated histories) must stop for a human
  // decision rather than be silently skipped or force-clobbered.
  if (strategy === 'diverged' && cfg.sync && !cfg.force && !cfg.forceExisting) {
    throw new VectorError(
      `Branch "${branch}" has DIVERGED from the destination — the remote tip (${remoteSha.slice(0, 10)}) ` +
      `is not an ancestor of the rewritten tip (${localSha.slice(0, 10)}), so a sync cannot fast-forward it.\n` +
      `  Inspect the destination, then re-run with --force-existing to apply the new history (its commit SHAs will change), ` +
      `or migrate fewer branches with --branch to exclude it.`,
      EXIT.DIVERGENCE,
    );
  }

  const doPush = (force = false) =>
    run('git', [...gd, 'push', ...(force ? ['--force'] : []), cfg.githubSsh, `refs/heads/${branch}:refs/heads/${branch}`],
      { env: cfg.gitEnv, capture: true, tee: true }); // tee: live progress + captured stderr (GH001 detection)

  let forced = false;
  switch (strategy) {
    case 'create':
      await doPush(); ui.ok(`[${branch}] created on the destination (new branch).`); break;
    case 'noop':
      ui.ok(`[${branch}] already present and identical — skipped (no re-push).`); break;
    case 'fast-forward': {
      const ahead = query('git', [...gd, 'rev-list', '--count', `${remoteSha}..${localSha}`]) || '?';
      await doPush(); ui.ok(`[${branch}] fast-forwarded (+${ahead} commit(s)) — existing history preserved.`); break;
    }
    case 'remote-ahead':
      ui.warn(`[${branch}] remote is AHEAD — skipping to protect destination history.`); break;
    case 'diverged':
      // An identity rewrite produces NEW SHAs, so an already-pushed branch diverges.
      // Never overwrite by default; force only on an explicit opt-in.
      if (cfg.force || cfg.forceExisting) {
        await doPush(true); forced = true;
        ui.warn(`[${branch}] force-updated on the destination — the new identities changed its commit SHAs.`);
      } else {
        ui.warn(`[${branch}] already on the destination but DIFFERS — skipped. Use --force-existing to apply the new identities (commit SHAs will change).`);
      }
      break;
  }
  return { branch, strategy, forced, localSha, remoteSha };
}

/**
 * Pure: tally per-branch push outcomes for the run summary.
 * @returns {{created,fastForwarded,upToDate,differs,forceUpdated,remoteAhead,missing:string[]}}
 */
export function summarizePushes(pushes = []) {
  const b = { created: [], fastForwarded: [], upToDate: [], differs: [], forceUpdated: [], remoteAhead: [], missing: [] };
  for (const p of pushes) {
    if (p.strategy === 'create') b.created.push(p.branch);
    else if (p.strategy === 'fast-forward') b.fastForwarded.push(p.branch);
    else if (p.strategy === 'noop') b.upToDate.push(p.branch);
    else if (p.strategy === 'remote-ahead') b.remoteAhead.push(p.branch);
    else if (p.strategy === 'diverged') (p.forced ? b.forceUpdated : b.differs).push(p.branch);
    else if (p.strategy === 'missing-local') b.missing.push(p.branch);
  }
  return b;
}

/** Pure: one-line human summary of a migration's pushes. */
export function formatPushSummary(pushes = []) {
  const b = summarizePushes(pushes);
  const named = (arr) => (arr.length ? ` (${arr.join(', ')})` : '');
  const parts = [`Pushed: ${b.created.length} new`];
  if (b.fastForwarded.length) parts.push(`Fast-forwarded: ${b.fastForwarded.length}${named(b.fastForwarded)}`);
  parts.push(`Skipped (already present): ${b.upToDate.length}${named(b.upToDate)}`);
  parts.push(`Differs (use --force-existing): ${b.differs.length}${named(b.differs)}`);
  if (b.forceUpdated.length) parts.push(`Force-updated: ${b.forceUpdated.length}${named(b.forceUpdated)}`);
  if (b.remoteAhead.length) parts.push(`Remote ahead (skipped): ${b.remoteAhead.length}${named(b.remoteAhead)}`);
  return parts.join(' · ');
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

/** Full pipeline: idempotent, incremental, non-destructive, mode-routed, integrity-checked. */
export async function migrate(cfg, ui = defaultUi) {
  await ensureGithubSsh(cfg, ui); // stop early if SSH isn't set up — never push-fail late
  const sync = await syncSourceMirror(cfg, ui);
  const staging = await buildStaging(cfg, ui);
  // Resolve case-insensitive / directory-file branch conflicts before the rewrite,
  // so git-filter-repo can't crash with "cannot lock ref" on Windows/macOS.
  const conflicts = await resolveBranchConflicts(cfg, ui);

  // Pre-flight: detect blobs over GitHub's per-file limit and decide how to handle
  // them BEFORE any push, so we never fail at the very last step. Runs before the
  // rewrite so a strip can ride along inside the same git-filter-repo pass.
  const largeFiles = await planLargeFileRemediation(cfg, ui);

  // Strategy: 'rewrite' rewrites identities; 'mirror' copies verbatim. A rewrite
  // whose mapping matches 0 commits auto-falls-back to mirror (Section 2 / spec) —
  // rewriting nothing would only churn SHAs for no benefit.
  const entries = parseMailmap(cfg.mailmapText || '');
  let decision = { strategy: cfg.baseStrategy || 'rewrite', fallback: false };
  if ((cfg.baseStrategy || 'rewrite') === 'rewrite') {
    const applicable = entries.length > 0 && mappingsApplicable(historyIdentities(cfg), entries);
    decision = decideRewriteStrategy({ baseStrategy: 'rewrite', applicableCommits: applicable ? 1 : 0 });
    if (decision.fallback) ui.warn(`Auto-fallback to mirror — ${decision.reason}`);
  }

  // Fold a strip into the identity rewrite when we're rewriting anyway (one pass,
  // not two). When mirroring (or no rewrite runs), the strip/LFS pass runs on its
  // own just below. Dry-run rewrites nothing.
  const foldStrip = largeFiles.action === 'strip' && largeFiles.offenders.length > 0
    && decision.strategy === 'rewrite' && !cfg.dryRun;

  let rewrite = { rewritten: false, strategy: decision.strategy };
  if (decision.strategy === 'rewrite') {
    rewrite = { ...(await rewriteHistory(cfg, ui, { stripBlobsBiggerThanMB: foldStrip ? largeFiles.limitMb : null })), strategy: 'rewrite' };
  } else {
    ui.ok('Mirror strategy — copying history verbatim (no identity rewrite).');
  }

  // Apply any remediation not folded into the rewrite (strip in mirror mode, or an
  // LFS migration), then warn honestly about the rewritten history.
  const remediation = await applyLargeFileRemediation(cfg, ui, largeFiles, { folded: foldStrip });

  // Resolve the branch set after the mirror exists. Default = every branch;
  // an explicit --branch list narrows it; --all-branches forces all.
  const branches = resolveBranches({
    explicit: cfg.branchesExplicit ? cfg.branches : [],
    allBranches: !!cfg.allBranches,
    available: listBranches(cfg),
  });
  // Belt & suspenders: even though the pre-flight scan normally prevents it, if a
  // push is still rejected for an oversized file (GH001), translate the raw exit
  // code into a plain-language message that names the remediation flags.
  const tags = cfg.branchesExplicit ? [] : listTags(cfg);
  const pushes = [];
  const tagPushes = [];
  try {
    for (const branch of branches) pushes.push(await pushBranch(cfg, branch, ui));
    for (const tag of tags) tagPushes.push(await pushTag(cfg, tag, ui));
  } catch (e) {
    const gh = parseGH001(`${e.message || ''}\n${e.stderr || ''}`);
    if (!gh.matched) throw e;
    throw new VectorError(formatGH001Guidance(gh, { maxFileSizeMb: largeFiles.limitMb }), EXIT.GIT);
  }

  // Integrity gate: verify what we synced is intact on the destination. Skipped on
  // --dry-run (which wrote nothing). Any mismatch aborts with a precise report.
  let integrity = null;
  if (!cfg.dryRun) {
    integrity = verifyIntegrity(cfg, { pushes, tagPushes });
    if (integrity.ok) ui.ok(formatIntegrityReport(integrity));
    else throw new VectorError(`${formatIntegrityReport(integrity)}\nAborting — destination does not match the migrated history.`, EXIT.INTEGRITY);
  }

  return {
    mode: sync.mode,
    strategy: decision.strategy,
    fallback: decision.fallback ? decision.reason : null,
    rewrite,
    conflicts,
    caseSensitive: staging.caseSensitive,
    largeFiles: { limitMb: largeFiles.limitMb, action: largeFiles.action, offenders: largeFiles.offenders },
    remediation,
    branches,
    pushes,
    tags,
    tagPushes,
    integrity,
    verification: verify(cfg, branches),
  };
}
