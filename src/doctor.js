// ─────────────────────────────────────────────────────────────────────────────
// doctor.js — `vector-migrate --doctor`: an environment diagnostic that runs every
// prerequisite check and prints a PASS/FAIL report with one-line fixes, so a user
// (especially on Windows) can tell whether a failure is their setup or Vector.
//
// No migration, no network writes — only read-only probes (the GitHub SSH check is
// a read-only auth probe). All IO is injectable so the logic is testable offline.
// ─────────────────────────────────────────────────────────────────────────────
import { existsSync, accessSync, readFileSync, constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { checkPrerequisites, commandVersion } from './prereqs.js';
import { findSshKey, listLocalSshKeys, checkGithubSsh, sshAuthFailureGuidance } from './ssh.js';

function defaultSshVersion() {
  return commandVersion('ssh', ['-V']); // ssh -V prints to stderr and exits 0
}

function defaultKnownHostsContains(host, { home } = {}) {
  try {
    const f = join(home || homedir(), '.ssh', 'known_hosts');
    return existsSync(f) && readFileSync(f, 'utf8').includes(host);
  } catch { return false; }
}

function defaultFsutilAvailable() {
  const r = spawnSync('fsutil', [], { encoding: 'utf8' }); // prints usage; errors only if absent
  return !r.error;
}

function defaultCwdWritable() {
  try { accessSync(process.cwd(), constants.W_OK); return true; } catch { return false; }
}

/**
 * Run every environment check and return structured results. Every probe is
 * injectable via `deps` for offline tests.
 * @returns {{results:Array<{key,label,ok,detail,fix}>, issues:number, ok:boolean}}
 */
export function runDoctorChecks(deps = {}) {
  const platform = deps.platform || process.platform;
  const isWin = platform === 'win32';
  const results = [];
  const add = (key, label, ok, detail = '', fix = '') => results.push({ key, label, ok, detail, fix });

  // 1 + 2 — git and git-filter-repo.
  const pre = (deps.checkPrerequisites || checkPrerequisites)();
  for (const r of pre.results) {
    add(r.name, r.name, r.ok, r.ok ? (r.version || '') : '', r.ok ? '' : (r.help || '').split('\n')[0]);
  }

  // 3 — ssh client present.
  const sshVer = (deps.sshVersion || defaultSshVersion)();
  add('ssh', 'ssh client', !!sshVer, sshVer || '',
    sshVer ? '' : 'Install OpenSSH (Windows: Settings -> Optional features -> OpenSSH Client).');

  // 4 — SSH keys in ~/.ssh (list ALL of them).
  const keys = (deps.listLocalSshKeys || listLocalSshKeys)({ home: deps.home });
  const anyKey = (deps.findSshKey || findSshKey)({ home: deps.home });
  const haveKey = keys.length > 0 || anyKey.found;
  add('ssh-keys', 'SSH keys in ~/.ssh', haveKey,
    keys.length ? keys.join(', ') : (anyKey.found ? 'ssh-agent identity' : 'none found'),
    haveKey ? '' : 'Generate one: ssh-keygen -t rsa -b 4096 -C "you@example.com"');

  // 5 — GitHub SSH authentication (tries all keys / the agent; IdentitiesOnly=no).
  const gh = (deps.githubCheck || checkGithubSsh)({});
  add('github-auth', 'GitHub SSH authentication', gh.ok,
    gh.ok ? `authenticated as ${gh.user || 'your account'}` : (gh.reason || 'failed'),
    gh.ok ? '' : sshAuthFailureGuidance({ platform, keys, service: 'github', reason: gh.reason }));

  // 6 — github.com trusted in known_hosts.
  const known = (deps.knownHostsContains || defaultKnownHostsContains)('github.com', { home: deps.home });
  add('known-hosts', 'github.com in known_hosts', known, known ? 'present' : 'absent',
    known ? '' : 'Trust it: ssh-keyscan github.com >> ~/.ssh/known_hosts  (Vector also auto-trusts on first connect).');

  // 7 — Windows only: fsutil for case-sensitive ref storage.
  if (isWin) {
    const fsu = (deps.fsutilAvailable || defaultFsutilAvailable)();
    add('fsutil', 'fsutil (case-sensitivity support)', fsu, fsu ? 'available' : 'unavailable',
      fsu ? '' : 'Not fatal — Vector falls back to renaming case/path-conflicting branches.');
  }

  // 8 — write access to the current directory (Vector creates local mirror folders).
  const writable = (deps.cwdWritable || defaultCwdWritable)();
  add('cwd-write', 'write access to current directory', writable, writable ? 'writable' : 'NOT writable',
    writable ? '' : 'Run Vector from a directory you can write to (it creates local mirror folders there).');

  const issues = results.filter((r) => !r.ok).length;
  return { results, issues, ok: issues === 0 };
}

/** ✓/✗ marks; ASCII fallback for Windows cmd's default code page. */
export function doctorMarks(useAscii) {
  return useAscii ? { pass: '+', fail: 'x' } : { pass: '✓', fail: '✗' };
}

/** Pure: render the diagnostic report (header + per-check lines + fixes + summary). */
export function renderDoctorReport({ version, nodeVersion, platform, results, useAscii = false }) {
  const m = doctorMarks(useAscii);
  const lines = [`vector-migrate v${version} · node ${nodeVersion} · ${platform}`, ''];
  for (const r of results) {
    lines.push(`[${r.ok ? m.pass : m.fail}] ${r.label}${r.detail ? `  (${r.detail})` : ''}`);
    if (!r.ok && r.fix) for (const fl of r.fix.split('\n')) lines.push(`      ${fl}`);
  }
  const issues = results.filter((r) => !r.ok).length;
  lines.push('');
  lines.push(issues === 0
    ? 'Result: all checks passed'
    : `Result: ${issues} issue(s) found — fix the items marked [${m.fail}], then re-run`);
  return lines.join('\n');
}

/** Orchestrate: run checks, render, print. Returns {ok, issues, report}. */
export function doctor(deps = {}) {
  const platform = deps.platform || process.platform;
  const { results, ok, issues } = runDoctorChecks(deps);
  const report = renderDoctorReport({
    version: deps.version || 'unknown',
    nodeVersion: deps.nodeVersion || process.version,
    platform,
    results,
    // Windows cmd's default code page often can't render ✓/✗ → use ASCII there.
    useAscii: deps.useAscii != null ? deps.useAscii : platform === 'win32',
  });
  (deps.print || console.log)(report);
  return { ok, issues, report };
}
