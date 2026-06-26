// ─────────────────────────────────────────────────────────────────────────────
// cli.js — one unified, auto-detecting workflow:
//   1) source URL  2) destination  3) mirror  4) scan authors+branches
//   5) map identities (you→new by default, edit to add teammates)  6) rewrite+push
// Non-interactive runs supply the mapping via flags/env; there is NO mode menu.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, existsSync } from 'node:fs';
import { ui, c } from './ui.js';
import { createLogger } from './logger.js';
import {
  configFromEnv, mergeConfigs, finalizeConfig, validateRun, parseBranches, parseEmails,
  EXIT, VectorError,
} from './config.js';
import { MODES } from './modes.js';
import { checkPrerequisites } from './prereqs.js';
import { doctor } from './doctor.js';
import { migrate, ensureSshReady, syncSourceMirror, listAuthors, listBranches, formatPushSummary } from './pipeline.js';
import { parseMailmap, entriesToMailmap, summarizeMapping } from './team.js';
import {
  checkGithubSsh, checkAzureSsh, formatSshStatus,
  findSshKey, listLocalSshKeys, sshKeyGuidance, isAzureSshUrl, azureSshHost,
} from './ssh.js';

function version() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
    return pkg.version || '0.0.0';
  } catch { return '0.0.0'; }
}

const HELP = `
${c.bold('vector-migrate')} — interactive, zero-token repository migration with identity rewriting

${c.bold('USAGE')}
  vector-migrate [options]

Run with no options for the guided flow: pick a mode, then it mirrors the source,
scans every author and branch, maps YOU to your new identity (keeping everyone
else), rewrites, pushes all branches + tags, and verifies commit integrity.

${c.bold('MODES')} (skip the menu with --mode)
  a   🟦 Azure DevOps ➔ GitHub   (identity / email rewriting)
  b   🟩 Azure DevOps ➔ GitHub   (mirror only — no rewriting)
  c   🟪 GitHub ➔ GitHub          (identity / email rewriting)
  --mode <a|b|c>             MODE
  (A rewrite whose mapping matches 0 commits auto-falls-back to a verbatim mirror.)

${c.bold('SOURCE & DESTINATION')}
  --source <url>             SOURCE             Source repo (Azure or GitHub; HTTPS or SSH)
  --dest <url>               DEST               Destination GitHub repo (SSH recommended)
  --ssh-key <path>           SSH_KEY            Private key for the SSH push
  (Legacy aliases still work: --azure-url/AZURE_URL, --github-ssh/GITHUB_SSH.)

${c.bold('IDENTITY MAPPING')} (modes A/C; any combination, highest precedence first)
  --mailmap <path>           MAILMAP            git mailmap file (full mapping for CI)
  --map "old=New <new>"      MAPS               Inline mapping, repeatable
  --old-email <email>        OLD_EMAIL          Legacy single-identity: your old email
  --new-name <name>          NEW_NAME           …mapped to this name
  --new-email <email>        NEW_EMAIL          …and this verified GitHub email
  --extra-old-emails <list>  EXTRA_OLD_EMAILS   More old emails of yours (comma sep)

${c.bold('BRANCHES & SAFETY')}
  --branch <name>            PUSH_BRANCHES      Limit to specific branch (repeatable; skips tags)
  --all-branches             ALL_BRANCHES       Every branch (this is the default)
  --sync                     SYNC               Incremental sync onto an existing target (ff-only; prompts on divergence)
  --force                                       Allow force-push only on TRUE divergence
  --force-existing                              Apply new identities to branches ALREADY on the destination
                                                (force-update — commit SHAs change for those branches)

${c.bold('GENERAL')}
  --project <slug>           PROJECT            Local folder slug (auto-derived)
  --work-dir <path>          WORK_DIR           Staging directory (default ./.vector-staging)
  --json                     JSON               Machine-readable log output
  -v, --verbose
  -y, --yes                                     Assume "yes" at the confirm gate
  --non-interactive                             No prompts (rewrite modes need a complete mapping)
  --dry-run                                     Plan + rewrite locally; perform NO remote writes
  --check                                       Validate tools + config only, change nothing
  --doctor                                      Diagnose your environment (PASS/FAIL + fixes), change nothing
  -h, --help / -V, --version

${c.bold('EXIT CODES')}  0 ok · 2 bad input · 3 git failure · 4 integrity mismatch · 5 divergence needs a decision
`;

const VALUE_FLAGS = {
  '--azure-url': 'azureUrl', '--github-ssh': 'githubSsh', '--old-email': 'oldEmail',
  '--extra-old-emails': 'extraOldEmails', '--new-name': 'newName', '--new-email': 'newEmail',
  '--project': 'project', '--branches': 'branchesInput', '--ssh-key': 'sshKey',
  '--mailmap': 'mailmapPath',
  // New surface
  '--mode': 'mode', '--source': 'source', '--dest': 'dest', '--work-dir': 'workDir',
};

export function parseArgs(argv) {
  const opts = {
    help: false, version: false, check: false, doctor: false, force: false, forceExisting: false,
    assumeYes: false, nonInteractive: false, allBranches: false,
    dryRun: false, sync: false, json: false, verbose: false,
    interactive: !!process.stdin.isTTY,
    overrides: {}, branchList: [], mapList: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-V' || a === '--version') opts.version = true;
    else if (a === '--check') opts.check = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--sync') opts.sync = true;
    else if (a === '--json') opts.json = true;
    else if (a === '-v' || a === '--verbose') opts.verbose = true;
    else if (a === '--doctor') opts.doctor = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--force-existing') opts.forceExisting = true;
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
  if (opts.forceExisting) ov.forceExisting = true;
  if (opts.allBranches) ov.allBranches = true;
  if (opts.dryRun) ov.dryRun = true;
  if (opts.sync) ov.sync = true;
  if (opts.json) ov.json = true;
  if (opts.verbose) ov.verbose = true;
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

function printVerification(result, log = ui) {
  log.step('Verification');
  for (const v of result.verification) {
    if (v.status === 'in-sync') log.ok(`[${v.branch}] OK — remote == local (${v.localSha})`);
    else if (v.status === 'missing-local') log.warn(`[${v.branch}] not in source — skipped`);
    else log.warn(`[${v.branch}] left intentionally untouched (${v.status})`);
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
  const localKeys = listLocalSshKeys({});
  const key = findSshKey({ explicitKey: final.sshKey });
  if (key.found) {
    ui.ok(`SSH key:     present${localKeys.length ? ` (${localKeys.join(', ')})` : ' (ssh-agent)'}`);
    ui.dim('             any one of these can work — it must be registered with GitHub/Azure');
  } else {
    ui.warn('SSH key:     NONE FOUND');
    for (const line of sshKeyGuidance({}).split('\n')) ui.warn(`  ${line}`);
  }

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
  let opts;
  try {
    opts = parseArgs(argv); // bad flags / missing flag values are usage errors
  } catch (e) {
    throw new VectorError(e.message, EXIT.USAGE);
  }
  if (opts.help) { console.log(HELP); return; }
  if (opts.version) { console.log(version()); return; }
  if (opts.doctor) { const res = doctor({ version: version() }); if (!res.ok) process.exitCode = 1; return; }

  // --json implies non-interactive (machine output, no prompts).
  if (opts.json) opts.interactive = false;
  const log = createLogger({ json: opts.json, verbose: opts.verbose });

  log.banner('🧭 vector-migrate — repository migration with identity rewriting');

  let cfg = assembleConfig(opts);
  if (cfg.mode && !['a', 'b', 'c'].includes(String(cfg.mode).trim().toLowerCase())) {
    throw new VectorError(`Invalid --mode "${cfg.mode}" (expected a, b, or c).`, EXIT.USAGE);
  }

  if (opts.check) { runCheck(cfg); return; }

  // ── Validate host tools up front ──
  const pre = checkPrerequisites();
  if (!pre.ok) { printPrereqs(pre); throw new VectorError('Required tools are missing (see guidance above).', EXIT.USAGE); }

  // ── Step 0: pick a mode (interactive menu when none was supplied) ──
  if (!cfg.mode && opts.interactive) {
    const { chooseMode } = await import('./wizard.js');
    cfg = mergeConfigs(cfg, { mode: await chooseMode() });
  }

  // ── Steps 1–2: source URL + destination (prompt only what's missing) ──
  if ((!(cfg.azureUrl || cfg.source) || !(cfg.githubSsh || cfg.dest)) && opts.interactive) {
    const { runBaseWizard } = await import('./wizard.js');
    const sourceLabel = (cfg.mode === 'c')
      ? 'GitHub source repo URL (HTTPS or SSH):'
      : 'Azure DevOps repository URL:';
    cfg = mergeConfigs(cfg, await runBaseWizard(cfg, { sourceLabel }));
  }
  cfg = withMailmapFile(cfg);
  let final = finalizeConfig(cfg);

  // ── Fail-fast SSH preflight before any mirror/rewrite work ──
  await ensureSshReady(final, log);
  cfg = mergeConfigs(cfg, { skipSshPreflight: true });
  final = finalizeConfig(cfg);

  // ── Steps 3–5 (interactive rewrite modes): mirror → scan → map identities ──
  // Mirror mode (B, or an inferred 0-mapping run) needs no identity mapping.
  const haveMapping = !!(final.mailmapText && final.mailmapText.trim());
  const wantsRewrite = final.baseStrategy === 'rewrite';
  if (opts.interactive && wantsRewrite && !haveMapping) {
    const baseV = validateRun(final, { interactive: true });
    if (!baseV.ok) throw new VectorError(`Incomplete configuration:\n  - ${baseV.errors.join('\n  - ')}`, EXIT.USAGE);

    log.step('Mirroring the source repository and scanning authors + branches');
    await syncSourceMirror(final, log);
    const identities = listAuthors(final); // scans the fetched mirror, never a local clone
    const branchesAvail = listBranches(final, final.sourceMirror);
    if (!identities.length) throw new VectorError('No author identities found in the mirrored repository.', EXIT.GIT);
    log.ok(`Detected ${identities.length} author(s) across ${branchesAvail.length} branch(es).`);

    const { runMappingWizard } = await import('./wizard.js');
    const entries = await runMappingWizard(identities);
    cfg = mergeConfigs(cfg, { mailmapText: entriesToMailmap(entries) });
    final = finalizeConfig(cfg);
    final._identities = identities;
    final._branchesAvail = branchesAvail;
  }

  // ── Validate completeness (strict in non-interactive) ──
  const v = validateRun(final, { interactive: opts.interactive });
  if (!v.ok) throw new VectorError(`Incomplete configuration:\n  - ${v.errors.join('\n  - ')}`, EXIT.USAGE);

  // ── Summary ──
  log.step('Summary');
  log.info(`  ${c.dim('Mode       :')} ${MODES[final.mode] ? MODES[final.mode].label : final.mode}`);
  log.info(`  ${c.dim('Strategy   :')} ${final.baseStrategy}${final.sync ? ' · sync (ff-only)' : ''}${final.dryRun ? ' · DRY-RUN (no writes)' : ''}`);
  log.info(`  ${c.dim('Source     :')} ${final.azureUrl}`);
  log.info(`  ${c.dim('Destination:')} ${final.githubSsh}`);
  log.info(`  ${c.dim('Branches   :')} ${branchDisplay(final)}`);
  if (final._identities) {
    const s = summarizeMapping(final._identities, parseMailmap(final.mailmapText));
    log.info(`  ${c.dim('Identities :')} ${s.authors} authors · ${s.mapped} mapped · ${s.unchanged} kept`);
  } else if (wantsRewrite) {
    log.info(`  ${c.dim('Identities :')} ${final.rewriteEmails.length} mapped, others kept`);
  } else {
    log.info(`  ${c.dim('Identities :')} mirror — copied verbatim (no rewrite)`);
  }

  // ── Confirm gate (interactive) ──
  if (opts.interactive && !opts.assumeYes) {
    const { confirmProceed } = await import('./wizard.js');
    const n = final.rewriteEmails.length;
    const msg = !wantsRewrite
      ? (final.dryRun ? 'Plan this mirror (dry-run, no writes)?' : 'Mirror this repository to the destination?')
      : (final.dryRun ? 'Plan this rewrite (dry-run, no writes)?'
        : (n > 1 ? `This rewrites ${n} identities — including OTHER people's commits. Proceed and push?` : 'Rewrite history and push?'));
    if (!(await confirmProceed(msg))) { log.warn('Aborted — no changes were made.'); return; }
  }

  // Interactive runs get to choose how branch-name conflicts are resolved;
  // non-interactive runs default to the safe, data-preserving choice (rename).
  if (opts.interactive) {
    const { chooseConflictResolution } = await import('./wizard.js');
    final._resolveConflicts = (conflicts) => chooseConflictResolution(conflicts);
  }

  // ── mirror (idempotent) → [rewrite] → ancestry-aware push → integrity verify ──
  const result = await migrate(final, log);
  if (result.fallback) log.warn(`Note: ${result.fallback}`);
  printVerification(result, log);
  log.step('Push summary');
  log.info(`  ${formatPushSummary(result.pushes)}`);
  if (result.tagPushes && result.tagPushes.length) {
    const created = result.tagPushes.filter((t) => t.strategy === 'create').length;
    const updated = result.tagPushes.filter((t) => t.strategy === 'update').length;
    log.info(`  Tags: ${created} created · ${updated} updated · ${result.tagPushes.length} total`);
  }
  if (final.dryRun) {
    log.ok('\n✅ Dry-run complete — planned everything above, wrote nothing to the destination.');
  } else {
    log.ok('\n✅ Migration complete — integrity verified (ref set + tip OIDs + commit count match).');
  }
  if (log.json) log.event('done', { mode: result.mode, strategy: result.strategy, integrity: result.integrity, branches: result.branches });
}
