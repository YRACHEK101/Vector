// ─────────────────────────────────────────────────────────────────────────────
// cli.js — one unified, auto-detecting workflow:
//   1) source URL  2) destination  3) mirror  4) scan authors+branches
//   5) map identities (you→new by default, edit to add teammates)  6) rewrite+push
// Non-interactive runs supply the mapping via flags/env; there is NO mode menu.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, existsSync } from 'node:fs';
import { ui, c } from './ui.js';
import {
  configFromEnv, mergeConfigs, finalizeConfig, validateRun, parseBranches, parseEmails,
} from './config.js';
import { checkPrerequisites } from './prereqs.js';
import { migrate, ensureSshReady, syncSourceMirror, listAuthors, listBranches } from './pipeline.js';
import { parseMailmap, entriesToMailmap, summarizeMapping } from './team.js';
import {
  checkGithubSsh, checkAzureSsh, formatSshStatus,
  findSshKey, sshKeyGuidance, isAzureSshUrl, azureSshHost,
} from './ssh.js';

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

Run with no options for the guided flow: it mirrors the Azure repo, scans every
author and branch, maps YOU to your new identity (keeping everyone else), then
rewrites and pushes all branches. Map more authors at the confirm step to migrate
a whole team — same single flow.

${c.bold('SOURCE & DESTINATION')}
  --azure-url <url>          AZURE_URL          Azure DevOps repo URL (always provided)
  --github-ssh <url>         GITHUB_SSH         Destination GitHub repo (SSH form)
  --ssh-key <path>           SSH_KEY            Private key for the SSH push

${c.bold('IDENTITY MAPPING')} (any combination; highest precedence first)
  --mailmap <path>           MAILMAP            git mailmap file (full mapping for CI)
  --map "old=New <new>"      MAPS               Inline mapping, repeatable
  --old-email <email>        OLD_EMAIL          Legacy single-identity: your old email
  --new-name <name>          NEW_NAME           …mapped to this name
  --new-email <email>        NEW_EMAIL          …and this verified GitHub email
  --extra-old-emails <list>  EXTRA_OLD_EMAILS   More old emails of yours (comma sep)

${c.bold('BRANCHES & SAFETY')}
  --branch <name>            PUSH_BRANCHES      Limit to specific branch (repeatable)
  --all-branches             ALL_BRANCHES       Every branch (this is the default)
  --force                                       Allow force-push only on TRUE divergence

${c.bold('GENERAL')}
  --project <slug>           PROJECT            Local folder slug (auto-derived)
  -y, --yes                                     Assume "yes" at the confirm gate
  --non-interactive                             No prompts (mapping must be complete)
  --check, --dry-run                            Validate tools + config, change nothing
  -h, --help / -V, --version
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
    assumeYes: false, nonInteractive: false, allBranches: false,
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
  const branches = opts.branchList.length
    ? opts.branchList
    : (ov.branchesInput ? parseBranches(ov.branchesInput) : []);
  delete ov.branchesInput;
  if (branches.length) ov.branches = branches;
  if (opts.force) ov.force = true;
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
  if (!pre.ok) { ui.info(''); for (const m of pre.missing) ui.warn(m.help); }
}

function readMailmapFile(path) {
  if (!path) return '';
  if (!existsSync(path)) throw new Error(`Mailmap file not found: ${path}`);
  return readFileSync(path, 'utf8');
}

function branchDisplay(final) {
  if (final.allBranches) return 'ALL (every branch)';
  if (final.branchesExplicit) return final.branches.join(', ');
  return 'ALL (every branch — default)';
}

function printVerification(result) {
  ui.step('Verification');
  for (const v of result.verification) {
    if (v.status === 'in-sync') ui.ok(`[${v.branch}] OK — remote == local (${v.localSha})`);
    else if (v.status === 'missing-local') ui.warn(`[${v.branch}] not in source — skipped`);
    else ui.warn(`[${v.branch}] left intentionally untouched (${v.status})`);
  }
}

/** Fold a provided --mailmap file into cfg as mailmapText so finalize can parse it. */
function withMailmapFile(cfg) {
  if (!cfg.mailmapPath) return cfg;
  return mergeConfigs(cfg, { mailmapText: readMailmapFile(cfg.mailmapPath) });
}

// ── --check: validate tools + config, change nothing ─────────────────────────
function runCheck(cfg) {
  const pre = checkPrerequisites();
  printPrereqs(pre);
  ui.step('Configuration');
  let final;
  try {
    final = finalizeConfig(withMailmapFile(cfg));
    if (final.mailmapPath) {
      ui.ok(`Mailmap:   ${parseMailmap(final.mailmapText).length} mapping(s) parsed from ${final.mailmapPath}`);
    }
  } catch (e) { ui.warn(`• ${e.message}`); final = finalizeConfig(cfg); }

  ui.ok(`Source:    ${final.azureUrl || '(not set)'}`);
  ui.ok(`Dest:      ${final.githubSsh || '(not set)'}`);
  ui.ok(`Mappings:  ${final.rewriteEmails.length} identity remap(s)`);
  ui.ok(`Branches:  ${branchDisplay(final)}`);
  ui.ok(existsSync(final.sourceMirror)
    ? `Sync:      INCREMENTAL (existing mirror at ${final.sourceMirror})`
    : 'Sync:      INITIAL (a fresh mirror will be created)');

  // Report config issues (a CI run would use --non-interactive, so check strictly).
  for (const e of validateRun(final, { interactive: false }).errors) ui.warn(`• ${e}`);

  // SSH status — Vector authenticates over SSH, so verify a key exists and that
  // GitHub (always) and Azure (only when the source url is SSH) accept it.
  ui.step('SSH access');
  const key = findSshKey({ explicitKey: final.sshKey });
  if (key.found) ui.ok(`SSH key:     present (${key.source === 'agent' ? 'ssh-agent' : key.source})`);
  else { ui.warn('SSH key:     NONE FOUND'); for (const line of sshKeyGuidance({}).split('\n')) ui.warn(`  ${line}`); }

  const ssh = formatSshStatus(checkGithubSsh());
  for (const line of ssh.lines) (ssh.level === 'ok' ? ui.ok : ui.warn)(line);

  if (isAzureSshUrl(final.azureUrl)) {
    const az = checkAzureSsh({ host: azureSshHost(final.azureUrl) });
    if (az.ok) ui.ok('Azure SSH:   OK');
    else ui.warn(`Azure SSH:   FAILED — ${az.reason}`);
  } else if (final.azureUrl) {
    ui.ok('Azure SSH:   skipped (source url is HTTPS — only GitHub SSH is needed)');
  }

  if (!pre.ok) { process.exitCode = 1; ui.err('\nPreflight FAILED — install the missing tool(s) above.'); }
  else ui.ok('\n✅ Preflight OK — no changes were made.');
}

export async function run(argv) {
  const opts = parseArgs(argv);
  if (opts.help) { console.log(HELP); return; }
  if (opts.version) { console.log(version()); return; }

  ui.banner('🧭 vector-migrate — Azure DevOps → GitHub migration');

  let cfg = assembleConfig(opts);

  if (opts.check) { runCheck(cfg); return; }

  // ── Validate host tools up front ──
  const pre = checkPrerequisites();
  if (!pre.ok) { printPrereqs(pre); throw new Error('Required tools are missing (see guidance above).'); }

  // ── Steps 1–2: source URL + destination (prompt only what's missing) ──
  if ((!cfg.azureUrl || !cfg.githubSsh) && opts.interactive) {
    const { runBaseWizard } = await import('./wizard.js');
    cfg = mergeConfigs(cfg, await runBaseWizard(cfg));
  }
  cfg = withMailmapFile(cfg);
  let final = finalizeConfig(cfg);

  // ── Fail-fast SSH preflight before any mirror/rewrite work ──
  // Detects a missing key (stops with OS-specific ssh-keygen guidance), trusts
  // host keys, and verifies GitHub auth (always) + Azure auth (only when the
  // source url is SSH). Skips automatically for non-SSH targets. On success we
  // mark the config so migrate() doesn't re-probe the network a second time.
  await ensureSshReady(final, ui);
  cfg = mergeConfigs(cfg, { skipSshPreflight: true });
  final = finalizeConfig(cfg);

  // ── Steps 3–5 (interactive): mirror → scan → map identities ──
  const haveMapping = !!(final.mailmapText && final.mailmapText.trim());
  if (opts.interactive && !haveMapping) {
    const baseV = validateRun(final, { interactive: true });
    if (!baseV.ok) throw new Error(`Incomplete configuration:\n  - ${baseV.errors.join('\n  - ')}`);

    ui.step('Mirroring the Azure repository and scanning authors + branches');
    await syncSourceMirror(final, ui);
    const identities = listAuthors(final); // scans the fetched mirror, never a local clone
    const branchesAvail = listBranches(final, final.sourceMirror);
    if (!identities.length) throw new Error('No author identities found in the mirrored repository.');
    ui.ok(`Detected ${identities.length} author(s) across ${branchesAvail.length} branch(es).`);

    const { runMappingWizard } = await import('./wizard.js');
    const entries = await runMappingWizard(identities);
    cfg = mergeConfigs(cfg, { mailmapText: entriesToMailmap(entries) });
    final = finalizeConfig(cfg);
    final._identities = identities;
    final._branchesAvail = branchesAvail;
  }

  // ── Validate completeness (strict in non-interactive) ──
  const v = validateRun(final, { interactive: opts.interactive });
  if (!v.ok) throw new Error(`Incomplete configuration:\n  - ${v.errors.join('\n  - ')}`);

  // ── Summary ──
  ui.step('Summary');
  ui.info(`  ${c.dim('Source     :')} ${final.azureUrl}`);
  ui.info(`  ${c.dim('Destination:')} ${final.githubSsh}`);
  ui.info(`  ${c.dim('Branches   :')} ${branchDisplay(final)}`);
  if (final._identities) {
    const s = summarizeMapping(final._identities, parseMailmap(final.mailmapText));
    ui.info(`  ${c.dim('Identities :')} ${s.authors} authors · ${s.mapped} mapped · ${s.unchanged} kept`);
  } else {
    ui.info(`  ${c.dim('Identities :')} ${final.rewriteEmails.length} mapped, others kept`);
  }

  // ── Confirm gate (interactive) ──
  if (opts.interactive && !opts.assumeYes) {
    const { confirmProceed } = await import('./wizard.js');
    const n = final.rewriteEmails.length;
    const msg = n > 1
      ? `This rewrites ${n} identities — including OTHER people's commits. Proceed and push?`
      : 'Rewrite history and push?';
    if (!(await confirmProceed(msg))) { ui.warn('Aborted — no changes were made.'); return; }
  }

  // Interactive runs get to choose how branch-name conflicts are resolved;
  // non-interactive runs default to the safe, data-preserving choice (rename).
  if (opts.interactive) {
    const { chooseConflictResolution } = await import('./wizard.js');
    final._resolveConflicts = (conflicts) => chooseConflictResolution(conflicts);
  }

  // ── Steps 3,6: mirror (idempotent) → rewrite → ancestry-aware push, all branches ──
  const result = await migrate(final, ui);
  printVerification(result);
  ui.ok('\n✅ Migration complete. Every mapped author keeps attribution at original commit dates.');
}
