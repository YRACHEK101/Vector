// ─────────────────────────────────────────────────────────────────────────────
// wizard.js — the interactive prompt flow (inquirer is lazy-imported, so the rest
// of the CLI works even when only non-interactive paths are used).
// ─────────────────────────────────────────────────────────────────────────────
import { deriveProjectSlug } from './config.js';
import { query } from './git.js';

const required = (v) => (String(v ?? '').trim() ? true : 'This value is required.');

/**
 * Prompt the user for any configuration, pre-filling answers from `initial`
 * (env vars / flags) and smart git/derived defaults.
 * @returns {Promise<object>} camelCase config (branches/extraOldEmails as strings)
 */
export async function runWizard(initial = {}) {
  let inquirer;
  try {
    ({ default: inquirer } = await import('inquirer'));
  } catch {
    throw new Error(
      'The interactive wizard needs "inquirer". Install dependencies (npm install) or run ' +
      'non-interactively by passing --azure-url/--github-ssh/... flags or environment variables.',
    );
  }

  const gitName = query('git', ['config', '--global', 'user.name']) || '';
  const gitEmail = query('git', ['config', '--global', 'user.email']) || '';
  const branchDefault = initial.branches?.length ? initial.branches.join(' ') : 'master main';

  return inquirer.prompt([
    { type: 'input', name: 'azureUrl', message: 'Azure DevOps repository clone URL:', default: initial.azureUrl || undefined, validate: required },
    { type: 'input', name: 'githubSsh', message: 'Target GitHub repo (SSH, git@github.com:USER/REPO.git):', default: initial.githubSsh || undefined, validate: required },
    { type: 'input', name: 'project', message: 'Local project slug (folder names):', default: (a) => initial.project || deriveProjectSlug(a.githubSsh) || 'repo' },
    { type: 'input', name: 'oldEmail', message: 'Old corporate email used in the Azure commits:', default: initial.oldEmail || undefined, validate: required },
    { type: 'input', name: 'extraOldEmails', message: 'Additional OLD emails of yours (comma-separated, optional):', default: (initial.extraOldEmails || []).join(', ') || undefined },
    { type: 'input', name: 'newName', message: 'New author name / GitHub username:', default: initial.newName || gitName || undefined, validate: required },
    { type: 'input', name: 'newEmail', message: 'New personal (GitHub-verified) email:', default: initial.newEmail || gitEmail || undefined, validate: required },
    { type: 'input', name: 'branches', message: 'Branches to synchronize (space/comma separated):', default: branchDefault },
  ]);
}

async function loadInquirer() {
  try {
    return (await import('inquirer')).default;
  } catch {
    throw new Error(
      'The interactive wizard needs "inquirer". Install dependencies (npm install) or run ' +
      'non-interactively with --mailmap/--map (team mode) or flags/env (personal mode).',
    );
  }
}

/** Team mode: prompt only for the source/destination/slug (identities come from mapping). */
export async function runTeamBaseWizard(initial = {}) {
  const inquirer = await loadInquirer();
  return inquirer.prompt([
    { type: 'input', name: 'azureUrl', message: 'Azure DevOps repository clone URL:', default: initial.azureUrl || undefined, validate: required },
    { type: 'input', name: 'githubSsh', message: 'Target GitHub repo (SSH, git@github.com:USER/REPO.git):', default: initial.githubSsh || undefined, validate: required },
    { type: 'input', name: 'project', message: 'Local project slug (folder names):', default: (a) => initial.project || deriveProjectSlug(a.githubSsh) || 'repo' },
  ]);
}

/**
 * Team mode: given detected author identities, ask the operator to map each one
 * to a new "Name <email>" target — or leave it blank to keep it unchanged.
 * @returns {Promise<Array<{name:string,email:string,sourceEmail:string}>>}
 */
export async function runTeamWizard(identities = []) {
  const inquirer = await loadInquirer();
  const entries = [];
  for (const id of identities) {
    const { mapping } = await inquirer.prompt([{
      type: 'input',
      name: 'mapping',
      message: `Map  ${id.name} <${id.email}>  →  (blank = leave unchanged) "New Name <new@email>":`,
      validate: (v) => {
        const s = String(v ?? '').trim();
        if (!s) return true; // skip
        return /^.+\s*<[^\s@<>]+@[^\s@<>]+>\s*$/.test(s) ? true : 'Enter "New Name <new@email>" or leave blank.';
      },
    }]);
    const s = String(mapping ?? '').trim();
    if (!s) continue;
    const m = s.match(/^(.+?)\s*<([^>]+)>\s*$/);
    entries.push({ name: m[1].trim(), email: m[2].trim(), sourceEmail: id.email });
  }
  return entries;
}

/** Yes/no confirmation (team mode rewrites teammates, so we confirm first). */
export async function confirmProceed(message = 'Proceed?') {
  const inquirer = await loadInquirer();
  const { ok } = await inquirer.prompt([{ type: 'confirm', name: 'ok', message, default: false }]);
  return ok;
}
