// ─────────────────────────────────────────────────────────────────────────────
// wizard.js — interactive prompts for the unified flow (inquirer is lazy-imported
// so non-interactive paths work without it).
//   • runBaseWizard    — source URL, destination, slug
//   • runMappingWizard — "you → new identity" by default, edit to remap teammates
//   • confirmProceed   — the confirm gate before rewriting
// ─────────────────────────────────────────────────────────────────────────────
import { deriveProjectSlug } from './config.js';
import { query } from './git.js';
import { resolveYou, defaultNewIdentity, buildIdentityEntries } from './team.js';

const required = (v) => (String(v ?? '').trim() ? true : 'This value is required.');
const requiredEmail = (v) => (/^[^\s@<>]+@[^\s@<>]+$/.test(String(v ?? '').trim()) ? true : 'Enter a valid email address.');
const targetOrBlank = (v) => {
  const s = String(v ?? '').trim();
  if (!s) return true; // blank = keep unchanged
  return /^.+\s*<[^\s@<>]+@[^\s@<>]+>\s*$/.test(s) ? true : 'Enter "New Name <new@email>" or leave blank to keep.';
};

async function loadInquirer() {
  try {
    return (await import('inquirer')).default;
  } catch {
    throw new Error(
      'The interactive prompts need "inquirer". Install dependencies (npm install) or run ' +
      'non-interactively with --azure-url/--github-ssh plus a mapping (--mailmap/--map/--old-email…).',
    );
  }
}

/** Steps 1–2: the Azure source, the GitHub destination, and a local slug. */
export async function runBaseWizard(initial = {}) {
  const inquirer = await loadInquirer();
  return inquirer.prompt([
    { type: 'input', name: 'azureUrl', message: 'Azure DevOps repository URL:', default: initial.azureUrl || undefined, validate: required },
    { type: 'input', name: 'githubSsh', message: 'GitHub destination (SSH, git@github.com:USER/REPO.git):', default: initial.githubSsh || undefined, validate: required },
    { type: 'input', name: 'project', message: 'Local project slug (folder names):', default: (a) => initial.project || deriveProjectSlug(a.githubSsh) || 'repo' },
  ]);
}

/**
 * Step 5: map identities. Default = map YOU (matched by global git email, else
 * picked) to your new identity, keep everyone else. Operator may opt to remap
 * teammates too. Returns mailmap entries.
 */
export async function runMappingWizard(identities = []) {
  const inquirer = await loadInquirer();
  const gitName = query('git', ['config', '--global', 'user.name']) || '';
  const gitEmail = query('git', ['config', '--global', 'user.email']) || '';

  // Your new identity (defaults from global git config — usually your GitHub identity).
  const def = defaultNewIdentity({ gitName, gitEmail }) || { name: '', email: '' };
  const newAns = await inquirer.prompt([
    { type: 'input', name: 'newName', message: 'Your new author NAME (GitHub):', default: def.name || undefined, validate: required },
    { type: 'input', name: 'newEmail', message: 'Your new verified EMAIL (GitHub):', default: def.email || undefined, validate: requiredEmail },
  ]);
  const newIdentity = { name: newAns.newName.trim(), email: newAns.newEmail.trim() };

  // Who is "you"? Pre-select by matching git email; otherwise ask.
  let you = resolveYou({ identities, gitEmail });
  if (you) {
    process.stderr.write(`  Detected you as ${you.name} <${you.email}> (matches your git config).\n`);
  } else {
    const { youEmail } = await inquirer.prompt([{
      type: 'list', name: 'youEmail', message: 'Which detected author is YOU?',
      choices: identities.map((id) => ({ name: `${id.name} <${id.email}>`, value: id.email })),
    }]);
    you = identities.find((id) => id.email === youEmail);
  }

  // Everyone else is kept by default; offer to remap teammates.
  const others = identities.filter((id) => id.email.toLowerCase() !== you.email.toLowerCase());
  const teammates = [];
  if (others.length) {
    const { editTeam } = await inquirer.prompt([{
      type: 'confirm', name: 'editTeam', default: false,
      message: `Also remap any of the ${others.length} other author(s)? (default: keep them unchanged)`,
    }]);
    if (editTeam) {
      for (const id of others) {
        const { mapping } = await inquirer.prompt([{
          type: 'input', name: 'mapping', validate: targetOrBlank,
          message: `Map ${id.name} <${id.email}> → (blank = keep) "New Name <new@email>":`,
        }]);
        const s = String(mapping ?? '').trim();
        if (!s) continue;
        const m = s.match(/^(.+?)\s*<([^>]+)>\s*$/);
        teammates.push({ sourceEmail: id.email, target: { name: m[1].trim(), email: m[2].trim() } });
      }
    }
  }

  return buildIdentityEntries({ you, newIdentity, teammates });
}

/** The confirm gate before any rewrite. */
export async function confirmProceed(message = 'Proceed?') {
  const inquirer = await loadInquirer();
  const { ok } = await inquirer.prompt([{ type: 'confirm', name: 'ok', message, default: false }]);
  return ok;
}

/**
 * Ask how to handle case-insensitive / directory-file branch conflicts. The
 * default is the safe, data-preserving choice: rename every conflicting branch.
 * @returns {Promise<'rename'|'skip'|'abort'>}
 */
export async function chooseConflictResolution(conflicts = []) {
  const inquirer = await loadInquirer();
  const { choice } = await inquirer.prompt([{
    type: 'list', name: 'choice', default: 'rename',
    message: `${conflicts.length} branch-name conflict(s) would break the rewrite on this filesystem. How should Vector handle them?`,
    choices: [
      { name: 'Rename the conflicting branch(es) with a -N suffix (migrate everything)', value: 'rename' },
      { name: 'Skip the conflicting branch(es) (migrate the rest)', value: 'skip' },
      { name: 'Abort (re-run on Linux/WSL, or narrow with --branch)', value: 'abort' },
    ],
  }]);
  return choice;
}
