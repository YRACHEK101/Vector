// ─────────────────────────────────────────────────────────────────────────────
// config.js — pure configuration logic (no prompts, no side effects, no deps).
// Everything here is unit-tested.
// ─────────────────────────────────────────────────────────────────────────────
import { resolveMailmapEntries, buildLegacyEntries } from './team.js';
import { resolveMode, strategyForMode, detectHostKind, normalizeGitHubUrl } from './modes.js';

export const DEFAULT_BRANCHES = ['master', 'main'];
export const REQUIRED = ['azureUrl', 'githubSsh', 'oldEmail', 'newName', 'newEmail'];

/** GitHub's hard per-file limit (MB) — the default --max-file-size threshold. */
export const DEFAULT_MAX_FILE_MB = 100;
/** Valid --on-large-file actions. */
export const LARGE_FILE_ACTIONS = ['strip', 'lfs', 'abort', 'prompt'];

/**
 * Process exit codes — documented in the README so scripts can branch on them.
 *   0 success · 2 bad input/usage · 3 git/subprocess failure ·
 *   4 integrity mismatch · 5 ancestry divergence needing a human decision.
 */
export const EXIT = { OK: 0, USAGE: 2, GIT: 3, INTEGRITY: 4, DIVERGENCE: 5 };

/** An error that carries the process exit code the CLI should surface for it. */
export class VectorError extends Error {
  constructor(message, exitCode = EXIT.GIT) {
    super(message);
    this.name = 'VectorError';
    this.exitCode = exitCode;
  }
}

/**
 * Pure: the effective execution strategy after the 0-commit auto-fallback.
 * A rewrite with nothing to rewrite (the old identities match no commits) would
 * only churn SHAs for no benefit, so it downgrades to a verbatim mirror.
 * @returns {{strategy:'rewrite'|'mirror', fallback:boolean, reason?:string}}
 */
export function decideRewriteStrategy({ baseStrategy = 'rewrite', applicableCommits = 0 } = {}) {
  if (baseStrategy !== 'rewrite') return { strategy: 'mirror', fallback: false };
  if (Number(applicableCommits) > 0) return { strategy: 'rewrite', fallback: false };
  return {
    strategy: 'mirror',
    fallback: true,
    reason: 'the identity mapping matched 0 commits in the source history — mirroring verbatim instead of rewriting (which would only change SHAs for no benefit).',
  };
}

/**
 * Strict (throws): validate the user-supplied --max-file-size. Empty/unset → the
 * GitHub default. Used in the CLI parse layer so a bad value is a clean usage error.
 */
export function validateMaxFileSize(v) {
  if (v == null || String(v).trim() === '') return DEFAULT_MAX_FILE_MB;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    throw new VectorError(`--max-file-size must be a positive number of MB (got "${v}").`, EXIT.USAGE);
  }
  return n;
}

/** Strict (throws): validate the user-supplied --on-large-file action. */
export function validateOnLargeFile(v) {
  if (v == null || String(v).trim() === '') return '';
  const s = String(v).trim().toLowerCase();
  if (!LARGE_FILE_ACTIONS.includes(s)) {
    throw new VectorError(`--on-large-file must be one of ${LARGE_FILE_ACTIONS.join('|')} (got "${v}").`, EXIT.USAGE);
  }
  return s;
}

/** Lenient (never throws): coerce for finalizeConfig, which must stay total. */
export function coerceMaxFileMb(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_FILE_MB;
}
export function coerceOnLargeFile(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return LARGE_FILE_ACTIONS.includes(s) ? s : '';
}

/** Interpret an env flag as boolean: "1"/"true"/"yes"/"on" → true; "0"/""/unset → false. */
export function parseBool(v) {
  if (v === true) return true;
  if (v == null) return false;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

/** Split an env-provided map list (newline-separated, or comma when single-line). */
export function parseMapsEnv(raw) {
  if (!raw) return [];
  let parts = String(raw).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1 && (String(raw).match(/=/g) || []).length > 1) {
    parts = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  }
  return parts;
}

/** Derive a local folder slug from a GitHub SSH URL: git@github.com:USER/REPO.git → REPO */
export function deriveProjectSlug(githubSsh = '') {
  const last = String(githubSsh).split('/').pop() || '';
  return last.replace(/\.git$/i, '');
}

/** Normalize branch input (array | "a,b c" | "") into a clean array, with a fallback. */
export function parseBranches(input, fallback = DEFAULT_BRANCHES) {
  const arr = Array.isArray(input)
    ? input
    : String(input ?? '').split(/[\s,]+/);
  const clean = arr.map((s) => String(s).trim()).filter(Boolean);
  return clean.length ? clean : [...fallback];
}

/** Normalize email list input (array | "a@x, b@y" | "") into a clean array. */
export function parseEmails(input) {
  const arr = Array.isArray(input) ? input : String(input ?? '').split(/[\s,]+/);
  return arr.map((s) => String(s).trim()).filter(Boolean);
}

/** Build a git-filter-repo mailmap string remapping each old email to the new identity. */
export function buildMailmap(newName, newEmail, oldEmails = []) {
  const lines = parseEmails(oldEmails).map((e) => `${newName} <${newEmail}> <${e}>`);
  return lines.length ? lines.join('\n') + '\n' : '';
}

/** Read a camelCase config object from environment variables. */
export function configFromEnv(env = process.env) {
  return {
    project: env.PROJECT || '',
    oldEmail: env.OLD_EMAIL || '',
    extraOldEmails: parseEmails(env.EXTRA_OLD_EMAILS || ''),
    newName: env.NEW_NAME || '',
    newEmail: env.NEW_EMAIL || '',
    azureUrl: env.AZURE_URL || '',
    githubSsh: env.GITHUB_SSH || '',
    // New surface: --source/--dest aliases, mode, sync, work dir, json output.
    source: env.SOURCE || '',
    dest: env.DEST || '',
    mode: env.MODE || '',
    sync: parseBool(env.SYNC),
    json: parseBool(env.JSON),
    workDir: env.WORK_DIR || '',
    branches: env.PUSH_BRANCHES ? parseBranches(env.PUSH_BRANCHES) : [],
    sshKey: env.SSH_KEY || '',
    // Large-file pre-flight: size threshold (MB) and what to do with offenders.
    maxFileSize: env.MAX_FILE_SIZE || '',
    onLargeFile: env.ON_LARGE_FILE || '',
    // Identity matching: skip rewriting outright, or declare which author is you.
    skipIdentity: parseBool(env.SKIP_IDENTITY),
    me: env.ME || '',
    force: false,
    // Identity mapping sources (file / inline) and branch scope
    mailmapPath: env.MAILMAP || '',
    maps: parseMapsEnv(env.MAPS),
    allBranches: parseBool(env.ALL_BRANCHES),
  };
}

const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0);

/** Merge config objects left→right; a later non-empty value overrides an earlier one. */
export function mergeConfigs(...sources) {
  const out = {};
  for (const src of sources) {
    if (!src) continue;
    for (const [k, v] of Object.entries(src)) {
      if (!isEmpty(v)) out[k] = v;
    }
  }
  return out;
}

/** Validate that required fields are present and well-formed. */
export function validateConfig(cfg) {
  const errors = [];
  for (const k of REQUIRED) {
    if (isEmpty(cfg[k]) || String(cfg[k]).trim() === '') errors.push(`Missing required value: ${k}`);
  }
  if (cfg.githubSsh && !/^(git@|ssh:\/\/)/.test(cfg.githubSsh)) {
    errors.push('githubSsh should be an SSH URL, e.g. git@github.com:USER/REPO.git');
  }
  if (cfg.newEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cfg.newEmail)) {
    errors.push('newEmail does not look like a valid email address');
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Validate a unified run. The Azure source and GitHub destination are always
 * required; in --non-interactive mode the identity mapping must also be fully
 * specified up front (no "which author is you?" prompt is available).
 */
export function validateRun(final, { interactive = false } = {}) {
  const errors = [];
  const empty = (v) => v == null || String(v).trim() === '';
  if (empty(final.azureUrl)) errors.push('Missing source URL (--source / --azure-url / AZURE_URL).');
  if (empty(final.githubSsh)) errors.push('Missing GitHub destination (--dest / --github-ssh / GITHUB_SSH).');
  else if (!/^(git@|ssh:\/\/)/.test(final.githubSsh)) {
    errors.push('the destination should be an SSH URL, e.g. git@github.com:USER/REPO.git');
  }
  // Mirror mode (B, or a rewrite mode that will auto-fallback) needs no mapping; only
  // rewrite modes require a complete mapping up front when there is no prompt available.
  // --skip-identity (or a resolved auto-skip) drops that requirement: it's a mirror.
  const rewriteMode = final.baseStrategy ? final.baseStrategy === 'rewrite' : final.mode !== 'b';
  if (!interactive && rewriteMode && !final.skipIdentity) {
    const hasMapping = !!(final.mailmapText && final.mailmapText.trim());
    if (!hasMapping) {
      errors.push('A rewrite run with no prompt needs a complete identity mapping: provide --mailmap, --map, or --old-email with --new-name/--new-email; declare yourself with --me <email>; or skip with --skip-identity (or --mode b for a verbatim mirror).');
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Produce the fully-resolved config used by the pipeline: derived slug, default
 * branches, the de-duplicated list of old emails, on-disk mirror paths, and the
 * git transport environment.
 */
export function finalizeConfig(cfg, { cwd = process.cwd() } = {}) {
  // --source/--dest are the documented aliases for the source URL and the GitHub
  // destination; the legacy --azure-url/--github-ssh names still work.
  const azureUrl = cfg.azureUrl || cfg.source || '';
  const githubSsh = cfg.githubSsh || cfg.dest || '';
  const project = cfg.project || deriveProjectSlug(githubSsh) || 'repo';
  const allOldEmails = parseEmails([cfg.oldEmail, ...(cfg.extraOldEmails || [])]);
  const sshKey = cfg.sshKey || '';
  // accept-new trusts a never-before-seen host key on first contact without a
  // prompt, so a fresh machine's clone/push won't die on "Host key verification
  // failed" in BatchMode. (The preflight also seeds known_hosts via ssh-keyscan.)
  const gitEnv = {
    GIT_SSH_COMMAND: sshKey
      ? `ssh -i ${sshKey} -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`
      : 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
  };

  // Branch scope. The pipeline default is EVERY branch (resolved after the mirror
  // exists). `branches` keeps the legacy default for display/back-compat, while
  // `branchesExplicit` records whether the operator actually narrowed the set.
  const explicitBranches = parseBranches(cfg.branches, []);
  const branchesExplicit = explicitBranches.length > 0;
  const branches = branchesExplicit ? explicitBranches : [...DEFAULT_BRANCHES];

  // One unified identity mapping built from every source (highest precedence wins):
  //   --mailmap file  >  --map inline  >  --old-email/--new-* legacy trio.
  // Interactive answers arrive pre-resolved as cfg.mailmapText (the file tier).
  const legacyEntries = buildLegacyEntries({
    oldEmail: cfg.oldEmail, extraOldEmails: cfg.extraOldEmails, newName: cfg.newName, newEmail: cfg.newEmail,
  });
  const resolved = resolveMailmapEntries({
    fileText: cfg.mailmapText || '',
    mapStrings: cfg.maps || [],
    legacyEntries,
  });

  // Routing: resolve the mode (explicit --mode wins, else inferred from the source
  // host + whether a mapping exists) and the base strategy it implies. The runtime
  // 0-commit fallback (decideRewriteStrategy) may still downgrade rewrite→mirror.
  const hasRewrite = !!(resolved.text && resolved.text.trim());
  const mode = resolveMode({ mode: cfg.mode, source: azureUrl, hasRewrite });
  const baseStrategy = strategyForMode(mode);
  const sourceKind = detectHostKind(azureUrl);
  // Mode C accepts an HTTPS or SSH GitHub source — normalize to SSH for a consistent
  // auth/push path; non-GitHub sources pass through unchanged.
  const normalizedSource = sourceKind === 'github' ? normalizeGitHubUrl(azureUrl, 'ssh') : azureUrl;

  // Staging lives under a single work dir (default ./.vector-staging) so the host
  // stays tidy and a sync can reuse the same deterministic layout.
  const workDir = cfg.workDir || `${cwd}/.vector-staging`;

  return {
    ...cfg,
    azureUrl: normalizedSource,
    githubSsh,
    project,
    mode,
    baseStrategy,
    sourceKind,
    sync: !!cfg.sync,
    dryRun: !!cfg.dryRun,
    json: !!cfg.json,
    verbose: !!cfg.verbose,
    workDir,
    branches,
    branchesExplicit,
    allOldEmails,
    sshKey,
    force: !!cfg.force,
    forceExisting: !!cfg.forceExisting,
    allBranches: !!cfg.allBranches,
    // Large-file pre-flight (coerced, never throws — strict validation is in the CLI).
    maxFileSizeMb: coerceMaxFileMb(cfg.maxFileSize),
    onLargeFile: coerceOnLargeFile(cfg.onLargeFile),
    skipLargeFileScan: !!cfg.skipLargeFileScan,
    // Identity matching / skipping.
    skipIdentity: !!cfg.skipIdentity,
    me: String(cfg.me || '').trim(),
    mailmapText: resolved.text,
    rewriteEmails: resolved.rewriteEmails,
    hasNameOnlyMapping: resolved.hasNameOnly,
    gitEnv,
    sourceMirror: `${workDir}/${project}-source.git`,
    stagingMirror: `${workDir}/${project}-migration.git`,
    mailmapFile: `${workDir}/${project}-mailmap.txt`,
  };
}
