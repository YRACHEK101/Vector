// ─────────────────────────────────────────────────────────────────────────────
// config.js — pure configuration logic (no prompts, no side effects, no deps).
// Everything here is unit-tested.
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_BRANCHES = ['master', 'main'];
export const REQUIRED = ['azureUrl', 'githubSsh', 'oldEmail', 'newName', 'newEmail'];

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
 * Produce the fully-resolved config used by the pipeline: derived slug, default
 * branches, the de-duplicated list of old emails, on-disk mirror paths, and the
 * git transport environment.
 */
export function finalizeConfig(cfg, { cwd = process.cwd() } = {}) {
  const project = cfg.project || deriveProjectSlug(cfg.githubSsh) || 'repo';
  const branches = parseBranches(cfg.branches);
  const allOldEmails = parseEmails([cfg.oldEmail, ...(cfg.extraOldEmails || [])]);
  const sshKey = cfg.sshKey || '';
  const gitEnv = {
    GIT_SSH_COMMAND: sshKey
      ? `ssh -i ${sshKey} -o BatchMode=yes -o IdentitiesOnly=yes`
      : 'ssh -o BatchMode=yes',
  };
  return {
    ...cfg,
    project,
    branches,
    allOldEmails,
    sshKey,
    force: !!cfg.force,
    gitEnv,
    sourceMirror: `${cwd}/${project}-source.git`,
    stagingMirror: `${cwd}/${project}-migration.git`,
    mailmapFile: `${cwd}/${project}-mailmap.txt`,
  };
}
