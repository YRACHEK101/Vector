// ─────────────────────────────────────────────────────────────────────────────
// config.js — pure configuration logic (no prompts, no side effects, no deps).
// Everything here is unit-tested.
// ─────────────────────────────────────────────────────────────────────────────
import { resolveMailmapEntries, buildLegacyEntries } from './team.js';

export const DEFAULT_BRANCHES = ['master', 'main'];
export const REQUIRED = ['azureUrl', 'githubSsh', 'oldEmail', 'newName', 'newEmail'];

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
    branches: env.PUSH_BRANCHES ? parseBranches(env.PUSH_BRANCHES) : [],
    sshKey: env.SSH_KEY || '',
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
  if (empty(final.azureUrl)) errors.push('Missing Azure source URL (--azure-url / AZURE_URL).');
  if (empty(final.githubSsh)) errors.push('Missing GitHub destination (--github-ssh / GITHUB_SSH).');
  else if (!/^(git@|ssh:\/\/)/.test(final.githubSsh)) {
    errors.push('githubSsh should be an SSH URL, e.g. git@github.com:USER/REPO.git');
  }
  if (!interactive) {
    const hasMapping = !!(final.mailmapText && final.mailmapText.trim());
    if (!hasMapping) {
      errors.push('Non-interactive mode needs a complete identity mapping: provide --mailmap, --map, or --old-email with --new-name/--new-email.');
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
  const project = cfg.project || deriveProjectSlug(cfg.githubSsh) || 'repo';
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

  return {
    ...cfg,
    project,
    branches,
    branchesExplicit,
    allOldEmails,
    sshKey,
    force: !!cfg.force,
    forceExisting: !!cfg.forceExisting,
    allBranches: !!cfg.allBranches,
    mailmapText: resolved.text,
    rewriteEmails: resolved.rewriteEmails,
    hasNameOnlyMapping: resolved.hasNameOnly,
    gitEnv,
    sourceMirror: `${cwd}/${project}-source.git`,
    stagingMirror: `${cwd}/${project}-migration.git`,
    mailmapFile: `${cwd}/${project}-mailmap.txt`,
  };
}
