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
