// ─────────────────────────────────────────────────────────────────────────────
// cli.js — argument parsing and orchestration. Resolves configuration from
// flags → environment → interactive wizard, validates tools, then runs the
// pipeline with spinners and colored output.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, existsSync } from 'node:fs';
import { ui, c } from './ui.js';
import {
  configFromEnv, mergeConfigs, finalizeConfig, validateConfig,
  parseBranches, parseEmails,
} from './config.js';
import { checkPrerequisites } from './prereqs.js';
import { migrate, syncSourceMirror, listAuthors } from './pipeline.js';
import {
  resolveMailmapEntries, validateTeamConfig, validateModeFlags, summarizeMapping,
} from './team.js';

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

${c.bold('TEAM MIGRATION MODE')} (move a shared repo — all contributors, all branches)
  --team                     TEAM_MODE          Enable team migration mode
  --mailmap <path>           MAILMAP            Path to a git mailmap file
  --map "old=New <new>"      MAPS               Inline mapping (repeatable)
  --all-branches             ALL_BRANCHES       Migrate and push every branch
`;

const VALUE_FLAGS = {
  '--azure-url': 'azureUrl', '--github-ssh': 'githubSsh', '--old-email': 'oldEmail',
  '--extra-old-emails': 'extraOldEmails', '--new-name': 'newName', '--new-email': 'newEmail',
  '--project': 'project', '--branches': 'branchesInput', '--ssh-key': 'sshKey',
  '--mailmap': 'mailmapPath',
};

export function parseArgs(argv) {
  const opts = {
    help: false, version: false, check: false, force: false,
    assumeYes: false, nonInteractive: false,
    team: false, allBranches: false,
    interactive: !!process.stdin.isTTY,
    overrides: {}, branchList: [], mapList: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-V' || a === '--version') opts.version = true;
    else if (a === '--check' || a === '--dry-run') opts.check = true;
    else if (a === '--force') opts.force = true;
    else if (a === '-y' || a === '--yes') opts.assumeYes = true;
    else if (a === '--non-interactive') { opts.nonInteractive = true; opts.interactive = false; }
    else if (a === '--team') opts.team = true;
    else if (a === '--all-branches') opts.allBranches = true;
    else if (a === '--branch') { const v = argv[++i]; if (!v) throw new Error('--branch needs a value'); opts.branchList.push(v); }
    else if (a === '--map') { const v = argv[++i]; if (v == null) throw new Error('--map needs a value'); opts.mapList.push(v); }
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
  if (opts.team) ov.teamMode = true;
  if (opts.allBranches) ov.allBranches = true;
  if (opts.mapList.length) ov.maps = opts.mapList;
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

function readMailmapFile(path) {
  if (!path) return '';
  if (!existsSync(path)) throw new Error(`Mailmap file not found: ${path}`);
  return readFileSync(path, 'utf8');
}

/** Resolve the team mailmap from file + inline maps (+ interactive auto-detection). */
async function resolveTeamMailmap(final, opts) {
  const fileText = final.mailmapPath ? readMailmapFile(final.mailmapPath) : '';
  const mapStrings = final.maps || [];
  let interactiveEntries = [];
  let identities = [];

  const haveStatic = (fileText && fileText.trim()) || mapStrings.length;
  if (!haveStatic && opts.interactive) {
    ui.step('Auto-detecting author identities in the source repository');
    await syncSourceMirror(final, ui); // clone so we can scan authors
    identities = listAuthors(final);
    if (!identities.length) throw new Error('No author identities found in the source repository.');
    const { runTeamWizard } = await import('./wizard.js');
    interactiveEntries = await runTeamWizard(identities);
  }

  const resolved = resolveMailmapEntries({ fileText, mapStrings, interactiveEntries });
  return { ...resolved, identities };
}

function printVerification(result) {
  ui.step('Verification');
  for (const v of result.verification) {
    if (v.status === 'in-sync') ui.ok(`[${v.branch}] OK — remote == local (${v.localSha})`);
    else if (v.status === 'missing-local') ui.warn(`[${v.branch}] not in source — skipped`);
    else ui.warn(`[${v.branch}] left intentionally untouched (${v.status})`);
  }
}

export async function run(argv) {
  const opts = parseArgs(argv);
  if (opts.help) { console.log(HELP); return; }
  if (opts.version) { console.log(version()); return; }

  ui.banner('🧭 vector-migrate — Azure DevOps → GitHub migration');

  const cfg = assembleConfig(opts);

  // Reject flag combinations that don't make sense (e.g. --map/--mailmap without --team).
  const mf = validateModeFlags({ team: !!cfg.teamMode, mapCount: (cfg.maps || []).length, mailmapPath: cfg.mailmapPath || '' });
  if (!mf.ok) throw new Error(mf.errors.join('\n'));

  // ── --check: validate tools (+ config) and exit, touching nothing ──
  if (opts.check) {
    const pre = checkPrerequisites();
    printPrereqs(pre);
    const final = finalizeConfig(cfg);
    ui.step('Configuration');
    if (final.teamMode) {
      ui.ok('Mode:      TEAM');
      try {
        const fileText = final.mailmapPath ? readMailmapFile(final.mailmapPath) : '';
        const resolved = resolveMailmapEntries({ fileText, mapStrings: final.maps || [] });
        ui.ok(`Mappings:  ${resolved.count} parsed${final.mailmapPath ? ` from ${final.mailmapPath}` : ''}`);
        const v = validateTeamConfig({
          azureUrl: final.azureUrl, githubSsh: final.githubSsh, mappingCount: resolved.count,
          mailmapPath: final.mailmapPath, mailmapMissing: false,
        });
        for (const e of v.errors) ui.warn(`• ${e}`);
        if (resolved.count === 0 && !final.mailmapPath && !(final.maps || []).length) {
          ui.dim('(Provide --mailmap, repeatable --map, or run interactively to map authors.)');
        }
      } catch (e) { ui.warn(`• ${e.message}`); }
      ui.ok(`Branches:  ${final.allBranches ? 'ALL (every branch)' : final.branches.join(', ')}`);
    } else {
      const v = validateConfig(final);
      if (v.ok) {
        ui.ok(`Identity:  ${final.newName} <${final.newEmail}>`);
        ui.ok(`Branches:  ${final.allBranches ? 'ALL (every branch)' : final.branches.join(', ')}`);
      } else {
        for (const e of v.errors) ui.warn(`• ${e}`);
        ui.dim('(Provide the missing values via flags, env vars, or the wizard.)');
      }
    }
    ui.ok(existsSync(final.sourceMirror)
      ? `Sync:      INCREMENTAL (existing mirror at ${final.sourceMirror})`
      : 'Sync:      INITIAL (a fresh mirror will be created)');
    if (!pre.ok) { process.exitCode = 1; ui.err('\nPreflight FAILED — install the missing tool(s) above.'); }
    else ui.ok('\n✅ Preflight OK — no changes were made.');
    return;
  }

  // ── Real run: validate tools up front with clear guidance ──
  const pre = checkPrerequisites();
  if (!pre.ok) { printPrereqs(pre); throw new Error('Required tools are missing (see guidance above).'); }

  if (cfg.teamMode) {
    await runTeam(cfg, opts);
    return;
  }
  await runPersonal(cfg, opts);
}

/** Team Migration: multi-developer rewrite across all (or selected) branches. */
async function runTeam(cfg, opts) {
  let final = finalizeConfig(cfg);

  // Base fields needed even before author detection.
  if ((!final.azureUrl || !final.githubSsh) && opts.interactive) {
    const { runTeamBaseWizard } = await import('./wizard.js');
    const base = await runTeamBaseWizard(cfg);
    final = finalizeConfig(mergeConfigs(cfg, base));
    cfg = mergeConfigs(cfg, base);
  }

  const resolved = await resolveTeamMailmap(final, opts);
  const v = validateTeamConfig({
    azureUrl: final.azureUrl, githubSsh: final.githubSsh, mappingCount: resolved.count,
    mailmapPath: final.mailmapPath, mailmapMissing: final.mailmapPath ? !existsSync(final.mailmapPath) : false,
  });
  if (!v.ok) throw new Error(`Team configuration incomplete:\n  - ${v.errors.join('\n  - ')}`);

  // Bake the resolved mailmap into the config and recompute rewrite metadata.
  final = finalizeConfig(mergeConfigs(cfg, { mailmapText: resolved.text }));

  // ── Summary (team mode rewrites teammates by design — show it clearly) ──
  ui.step('Team Migration summary');
  ui.info(`  ${c.dim('Azure URL :')} ${final.azureUrl}`);
  ui.info(`  ${c.dim('GitHub SSH:')} ${final.githubSsh}`);
  ui.info(`  ${c.dim('Branches  :')} ${final.allBranches ? 'ALL (every branch)' : final.branches.join(', ')}`);
  ui.info(`  ${c.dim('Mappings  :')} ${resolved.count} developer identit${resolved.count === 1 ? 'y' : 'ies'} will be rewritten`);
  if (resolved.identities.length) {
    const s = summarizeMapping(resolved.identities, resolved.entries);
    ui.info(`  ${c.dim('Authors   :')} ${s.authors} detected — ${s.mapped} mapped, ${s.unchanged} left unchanged`);
  }
  ui.warn('  Team mode rewrites EVERY mapped developer\'s identity (not just yours).');

  if (opts.interactive && !opts.assumeYes) {
    const { confirmProceed } = await import('./wizard.js');
    if (!(await confirmProceed('Rewrite history for all mapped developers and push?'))) {
      ui.warn('Aborted — no changes were made.');
      return;
    }
  }

  const result = await migrate(final, ui);
  printVerification(result);
  ui.ok('\n✅ Team migration complete. Every mapped developer keeps attribution at original dates.');
}

/** Personal migration: rewrite your own identity, leave teammates untouched (unchanged behavior). */
async function runPersonal(cfg, opts) {
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

  ui.step('Configuration');
  ui.info(`  ${c.dim('Azure URL :')} ${final.azureUrl}`);
  ui.info(`  ${c.dim('GitHub SSH:')} ${final.githubSsh}`);
  ui.info(`  ${c.dim('Identity  :')} ${final.newName} <${final.newEmail}>`);
  ui.info(`  ${c.dim('Remap from:')} ${final.allOldEmails.join(', ')}`);
  ui.info(`  ${c.dim('Branches  :')} ${final.allBranches ? 'ALL (every branch)' : final.branches.join(', ')}`);
  ui.info(`  ${c.dim('Source dir:')} ${final.sourceMirror}`);
  if (existsSync(final.sourceMirror)) ui.ok('Existing mirror detected — this is an INCREMENTAL sync.');

  const result = await migrate(final, ui);
  printVerification(result);
  ui.ok('\n✅ Migration complete. Commits keep their original dates on your contribution graph.');
}
