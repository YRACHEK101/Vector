// ─────────────────────────────────────────────────────────────────────────────
// cli.js — argument parsing and orchestration. Resolves configuration from
// flags → environment → interactive wizard, validates tools, then runs the
// pipeline with spinners and colored output.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { ui, c, spinner } from './ui.js';
import {
  configFromEnv, mergeConfigs, finalizeConfig, validateConfig,
  parseBranches, parseEmails,
} from './config.js';
import { checkPrerequisites } from './prereqs.js';
import { migrate } from './pipeline.js';

function version() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
    return pkg.version || '0.0.0';
  } catch { return '0.0.0'; }
}

const HELP = `
${c.bold('vector-migrate')} — interactive, zero-token Azure DevOps → GitHub migration

${c.bold('USAGE')}
  vector-migrate [options]

Run with no options for the interactive wizard. Any value supplied via a flag or
environment variable is used directly; the wizard only asks for what's missing.

${c.bold('OPTIONS')}
  --azure-url <url>          AZURE_URL          Azure DevOps repo clone URL
  --github-ssh <url>         GITHUB_SSH         Target GitHub repo (SSH form)
  --old-email <email>        OLD_EMAIL          Old corporate email in history
  --extra-old-emails <list>  EXTRA_OLD_EMAILS   More OLD emails of yours (comma sep)
  --new-name <name>          NEW_NAME           New author name / GitHub username
  --new-email <email>        NEW_EMAIL          New verified GitHub email
  --project <slug>           PROJECT            Local folder slug (auto-derived)
  --branch <name>            PUSH_BRANCHES      Branch to push (repeatable)
  --branches "a,b c"         PUSH_BRANCHES      Several branches at once
  --ssh-key <path>           SSH_KEY            Private key for the SSH push
  --force                                       Allow force-push on TRUE divergence
  -y, --yes                                     Assume "yes" for confirmations
  --non-interactive                             Never prompt; require flags/env
  --check, --dry-run                            Validate tools + config, then exit
  -h, --help                                    Show this help
  -V, --version                                 Show version
`;

const VALUE_FLAGS = {
  '--azure-url': 'azureUrl', '--github-ssh': 'githubSsh', '--old-email': 'oldEmail',
  '--extra-old-emails': 'extraOldEmails', '--new-name': 'newName', '--new-email': 'newEmail',
  '--project': 'project', '--branches': 'branchesInput', '--ssh-key': 'sshKey',
};

export function parseArgs(argv) {
  const opts = {
    help: false, version: false, check: false, force: false,
    assumeYes: false, nonInteractive: false,
    interactive: !!process.stdin.isTTY,
    overrides: {}, branchList: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-V' || a === '--version') opts.version = true;
    else if (a === '--check' || a === '--dry-run') opts.check = true;
    else if (a === '--force') opts.force = true;
    else if (a === '-y' || a === '--yes') opts.assumeYes = true;
    else if (a === '--non-interactive') { opts.nonInteractive = true; opts.interactive = false; }
    else if (a === '--branch') { const v = argv[++i]; if (!v) throw new Error('--branch needs a value'); opts.branchList.push(v); }
    else if (VALUE_FLAGS[a]) { const v = argv[++i]; if (v == null) throw new Error(`${a} needs a value`); opts.overrides[VALUE_FLAGS[a]] = v; }
    else throw new Error(`Unknown argument: ${a} (run --help)`);
  }
  return opts;
}

/** Turn parsed args + env into a single camelCase config object (pre-finalize). */
function assembleConfig(opts) {
  const env = configFromEnv(process.env);
  const ov = { ...opts.overrides };
  if (ov.extraOldEmails != null) ov.extraOldEmails = parseEmails(ov.extraOldEmails);
  // branches: --branch (repeatable) wins, else --branches string, else env.
  const branches = opts.branchList.length
    ? opts.branchList
    : (ov.branchesInput ? parseBranches(ov.branchesInput) : []);
  delete ov.branchesInput;
  if (branches.length) ov.branches = branches;
  if (opts.force) ov.force = true;
  return mergeConfigs(env, ov);
}

function printPrereqs(pre) {
  ui.step('Checking host dependencies');
  for (const r of pre.results) {
    if (r.ok) ui.ok(`✓ ${r.name}  ${c.dim(r.version)}`);
    else ui.err(`✗ ${r.name} — not found`);
  }
  if (!pre.ok) {
    ui.info('');
    for (const m of pre.missing) ui.warn(m.help);
  }
}

export async function run(argv) {
  const opts = parseArgs(argv);
  if (opts.help) { console.log(HELP); return; }
  if (opts.version) { console.log(version()); return; }

  ui.banner('🧭 vector-migrate — Azure DevOps → GitHub migration');

  // ── --check: validate tools (+ config if present) and exit, touching nothing ──
  if (opts.check) {
    const pre = checkPrerequisites();
    printPrereqs(pre);
    let cfg = assembleConfig(opts);
    const final = finalizeConfig(cfg);
    const v = validateConfig(final);
    ui.step('Configuration');
    if (v.ok) {
      ui.ok(`Identity:  ${final.newName} <${final.newEmail}>`);
      ui.ok(`Branches:  ${final.branches.join(', ')}`);
      ui.ok(existsSync(final.sourceMirror)
        ? `Mode:      INCREMENTAL (existing mirror at ${final.sourceMirror})`
        : 'Mode:      INITIAL (a fresh mirror will be created)');
    } else {
      for (const e of v.errors) ui.warn(`• ${e}`);
      ui.dim('(Provide the missing values via flags, env vars, or the wizard.)');
    }
    if (!pre.ok) { process.exitCode = 1; ui.err('\nPreflight FAILED — install the missing tool(s) above.'); }
    else ui.ok('\n✅ Preflight OK — no changes were made.');
    return;
  }

  // ── Real run: validate tools up front with clear guidance ──
  const pre = checkPrerequisites();
  if (!pre.ok) { printPrereqs(pre); throw new Error('Required tools are missing (see guidance above).'); }

  // ── Resolve configuration: env + flags, then wizard for anything missing ──
  let cfg = assembleConfig(opts);
  let final = finalizeConfig(cfg);
  if (!validateConfig(final).ok) {
    if (opts.interactive) {
      const { runWizard } = await import('./wizard.js');
      const answers = await runWizard(cfg);
      cfg = mergeConfigs(cfg, {
        ...answers,
        extraOldEmails: parseEmails(answers.extraOldEmails),
        branches: parseBranches(answers.branches),
      });
      final = finalizeConfig(cfg);
    }
    const v = validateConfig(final);
    if (!v.ok) throw new Error(`Incomplete configuration:\n  - ${v.errors.join('\n  - ')}`);
  }

  // ── Summary ──
  ui.step('Configuration');
  ui.info(`  ${c.dim('Azure URL :')} ${final.azureUrl}`);
  ui.info(`  ${c.dim('GitHub SSH:')} ${final.githubSsh}`);
  ui.info(`  ${c.dim('Identity  :')} ${final.newName} <${final.newEmail}>`);
  ui.info(`  ${c.dim('Remap from:')} ${final.allOldEmails.join(', ')}`);
  ui.info(`  ${c.dim('Branches  :')} ${final.branches.join(', ')}`);
  ui.info(`  ${c.dim('Source dir:')} ${final.sourceMirror}`);
  if (existsSync(final.sourceMirror)) ui.ok('Existing mirror detected — this is an INCREMENTAL sync.');

  // ── Run the pipeline ──
  const result = await migrate(final, ui);

  ui.step('Verification');
  for (const v of result.verification) {
    if (v.status === 'in-sync') ui.ok(`[${v.branch}] OK — remote == local (${v.localSha})`);
    else if (v.status === 'missing-local') ui.warn(`[${v.branch}] not in source — skipped`);
    else ui.warn(`[${v.branch}] left intentionally untouched (${v.status})`);
  }
  ui.ok('\n✅ Migration complete. Commits keep their original dates on your contribution graph.');
}
