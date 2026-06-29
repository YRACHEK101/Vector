// ─────────────────────────────────────────────────────────────────────────────
// wizard.js — interactive prompts for the unified flow (inquirer is lazy-imported
// so non-interactive paths work without it).
//   • runBaseWizard    — source URL, destination, slug
//   • runMappingWizard — "you → new identity" by default, edit to remap teammates
//   • confirmProceed   — the confirm gate before rewriting
// ─────────────────────────────────────────────────────────────────────────────
import { deriveProjectSlug } from './config.js';
import { query } from './git.js';
import { defaultNewIdentity, buildIdentityEntries, myUnifyEmails, matchYou, youSignals } from './team.js';

// Sentinel + label for the explicit "I'm not a contributor — skip" escape hatch in
// the "Which detected author is YOU?" list. The sentinel can't collide with a real
// email (every real choice value is an address with an '@'), so appending it never
// disturbs the existing choices.
export const SKIP_IDENTITY_VALUE = '__vector_skip_identity__';
export const SKIP_IDENTITY_LABEL = "❮ None of these — I didn't contribute to this repo (skip identity rewriting) ❯";

const sameCi = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

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

/** Step 0: pick the migration mode (A/B/C). Returns 'a' | 'b' | 'c'. */
export async function chooseMode() {
  const inquirer = await loadInquirer();
  const { mode } = await inquirer.prompt([{
    type: 'list', name: 'mode', message: 'What kind of migration?', default: 'a',
    choices: [
      { name: '🟦  A — Azure DevOps ➔ GitHub   (identity / email rewriting)', value: 'a' },
      { name: '🟩  B — Azure DevOps ➔ GitHub   (mirror only — no rewriting)', value: 'b' },
      { name: '🟪  C — GitHub ➔ GitHub          (identity / email rewriting)', value: 'c' },
    ],
  }]);
  return mode;
}

/** Steps 1–2: the source URL, the GitHub destination, and a local slug (only the missing ones are asked). */
export async function runBaseWizard(initial = {}, { sourceLabel = 'Azure DevOps repository URL:' } = {}) {
  const inquirer = await loadInquirer();
  const haveSource = !!(initial.azureUrl || initial.source);
  const haveDest = !!(initial.githubSsh || initial.dest);
  const questions = [];
  if (!haveSource) questions.push({ type: 'input', name: 'azureUrl', message: sourceLabel, default: initial.azureUrl || initial.source || undefined, validate: required });
  if (!haveDest) questions.push({ type: 'input', name: 'githubSsh', message: 'GitHub destination (SSH, git@github.com:USER/REPO.git):', default: initial.githubSsh || initial.dest || undefined, validate: required });
  questions.push({
    type: 'input', name: 'project', message: 'Local project slug (folder names):',
    default: (a) => initial.project || deriveProjectSlug(a.githubSsh || initial.githubSsh || initial.dest) || 'repo',
  });
  return inquirer.prompt(questions);
}

/**
 * Step 5: map identities. Default = map YOU (matched by global git email, else
 * picked) to your new identity, keep everyone else. Operator may opt to remap
 * teammates too. Returns mailmap entries.
 */
export async function runMappingWizard(identities = [], opts = {}) {
  const inquirer = opts.inquirer || await loadInquirer();
  const gitName = opts.gitName != null ? opts.gitName : (query('git', ['config', '--global', 'user.name']) || '');
  const gitEmail = opts.gitEmail != null ? opts.gitEmail : (query('git', ['config', '--global', 'user.email']) || '');
  const githubUser = opts.githubUser || '';
  const me = opts.me || '';

  // Your new identity (defaults from global git config — usually your GitHub identity).
  const def = defaultNewIdentity({ gitName, gitEmail }) || { name: '', email: '' };
  const newAns = await inquirer.prompt([
    { type: 'input', name: 'newName', message: 'Your new author NAME (GitHub):', default: def.name || undefined, validate: required },
    { type: 'input', name: 'newEmail', message: 'Your new verified EMAIL (GitHub):', default: def.email || undefined, validate: requiredEmail },
  ]);
  const newIdentity = { name: newAns.newName.trim(), email: newAns.newEmail.trim() };

  // Who is "you"? Auto-match across every signal (new email/name, git config, the
  // GitHub username, an explicit --me) — email first, then name. If none matches,
  // never force a wrong pick: offer the list PLUS an explicit "skip" escape.
  const { emails, names } = youSignals({ newName: newIdentity.name, newEmail: newIdentity.email, gitName, gitEmail, githubUser, me });
  let you = matchYou({ identities, emails, names });
  if (you) {
    const why = sameCi(you.email, gitEmail) ? 'matches your git config'
      : sameCi(you.email, newIdentity.email) ? 'matches the email you entered'
        : 'auto-matched';
    process.stderr.write(`  Detected you as ${you.name} <${you.email}> (${why}).\n`);
  } else {
    if (me) process.stderr.write(`  --me "${me}" didn't match any detected author — pick below, or choose “None”.\n`);
    const { youEmail } = await inquirer.prompt([{
      type: 'list', name: 'youEmail', message: 'Which detected author is YOU?',
      choices: [
        ...identities.map((id) => ({ name: `${id.name} <${id.email}>`, value: id.email })),
        new inquirer.Separator(),
        { name: SKIP_IDENTITY_LABEL, value: SKIP_IDENTITY_VALUE },
      ],
    }]);
    if (youEmail === SKIP_IDENTITY_VALUE) {
      process.stderr.write('  Skipping identity rewriting — all authors kept unchanged.\n');
      return { entries: [], skipped: true };
    }
    you = identities.find((id) => id.email === youEmail);
  }

  // Every name under MY email(s) — source AND new — unifies to my new identity.
  const myEmails = new Set(myUnifyEmails({ you, newIdentity, identities }).map((e) => e.toLowerCase()));
  const myNames = identities.filter((id) => myEmails.has(id.email.toLowerCase()));
  const others = identities.filter((id) => !myEmails.has(id.email.toLowerCase()));
  if (myNames.length > 1) {
    process.stderr.write(`  Unifying ${myNames.length} of your names → ${newIdentity.name} <${newIdentity.email}>: ${myNames.map((i) => `"${i.name}"`).join(', ')}\n`);
  }

  // Everyone else is kept by default; offer to remap teammates, grouped by email.
  const teammates = [];
  if (others.length) {
    const byEmail = new Map();
    for (const id of others) {
      const k = id.email.toLowerCase();
      if (!byEmail.has(k)) byEmail.set(k, { email: id.email, names: [] });
      byEmail.get(k).names.push(id.name);
    }
    const groups = [...byEmail.values()];
    const { editTeam } = await inquirer.prompt([{
      type: 'confirm', name: 'editTeam', default: false,
      message: `Also remap any of the ${groups.length} other author email(s)? (default: keep them unchanged)`,
    }]);
    if (editTeam) {
      for (const g of groups) {
        const namesLabel = g.names.map((n) => `"${n}"`).join(', ');
        const { mapping } = await inquirer.prompt([{
          type: 'input', name: 'mapping', validate: targetOrBlank,
          message: `Map ${namesLabel} <${g.email}> → (blank = keep) "New Name <new@email>":`,
        }]);
        const s = String(mapping ?? '').trim();
        if (!s) continue;
        const m = s.match(/^(.+?)\s*<([^>]+)>\s*$/);
        teammates.push({ sourceEmail: g.email, target: { name: m[1].trim(), email: m[2].trim() } });
      }
    }
  }

  return { entries: buildIdentityEntries({ you, newIdentity, identities, teammates }), skipped: false };
}

/**
 * Ask how to handle files that exceed GitHub's size limit. Default is strip
 * (the safe "just make the push work" choice). The LFS option is offered only
 * when git-lfs is installed.
 * @returns {Promise<'strip'|'lfs'|'abort'>}
 */
export async function chooseLargeFileAction(offenders = [], { lfsAvailable = false } = {}) {
  const inquirer = await loadInquirer();
  const choices = [
    { name: 'Strip them from history (remove the file(s) from every commit, then push)', value: 'strip' },
  ];
  if (lfsAvailable) choices.push({ name: 'Move them to Git LFS (keep the file(s) via LFS pointers)', value: 'lfs' });
  choices.push({ name: 'Abort (leave history unchanged — fix it yourself)', value: 'abort' });
  const { choice } = await inquirer.prompt([{
    type: 'list', name: 'choice', default: 'strip',
    message: `${offenders.length} file(s) exceed GitHub's size limit. Stripping/LFS rewrites history (commit SHAs change). How should Vector proceed?`,
    choices,
  }]);
  return choice;
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
