// Offline tests for `--doctor`: every probe is injected (no child_process, no real
// filesystem, no network), so we can assert PASS/FAIL classification, the fix text,
// OS-correct rendering, and exit semantics deterministically.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDoctorChecks, renderDoctorReport, doctorMarks, doctor } from '../src/doctor.js';

// All-green dependency set; override per-test to force a specific failure.
const greenDeps = (over = {}) => ({
  platform: 'linux',
  checkPrerequisites: () => ({ results: [
    { name: 'git', ok: true, version: 'git version 2.50.0' },
    { name: 'git-filter-repo', ok: true, version: '2.38.0' },
  ] }),
  sshVersion: () => 'OpenSSH_9.0p1',
  listLocalSshKeys: () => ['id_ed25519.pub'],
  findSshKey: () => ({ found: true, source: 'file' }),
  githubCheck: () => ({ ok: true, user: 'octocat' }),
  knownHostsContains: () => true,
  cwdWritable: () => true,
  ...over,
});

const byKey = (results, key) => results.find((r) => r.key === key);

// ── All pass ─────────────────────────────────────────────────────────────────
test('doctor: all checks pass → ok, 0 issues, no fsutil row off Windows', () => {
  const { results, ok, issues } = runDoctorChecks(greenDeps());
  assert.equal(ok, true);
  assert.equal(issues, 0);
  assert.equal(byKey(results, 'fsutil'), undefined, 'fsutil row only on win32');
  assert.equal(byKey(results, 'github-auth').detail, 'authenticated as octocat');

  const report = renderDoctorReport({ version: '2.2.0', nodeVersion: 'v22.0.0', platform: 'linux', results, useAscii: false });
  assert.match(report, /vector-migrate v2\.2\.0 · node v22\.0\.0 · linux/);
  assert.match(report, /Result: all checks passed/);
  assert.doesNotMatch(report, /✗/);
});

// ── Missing git-filter-repo ──────────────────────────────────────────────────
test('doctor: missing git-filter-repo → that row fails with a fix; non-zero result', () => {
  const { results, ok, issues } = runDoctorChecks(greenDeps({
    checkPrerequisites: () => ({ results: [
      { name: 'git', ok: true, version: 'git version 2.50.0' },
      { name: 'git-filter-repo', ok: false, help: 'git-filter-repo is not installed or not on your PATH. Install it…' },
    ] }),
  }));
  assert.equal(ok, false);
  assert.ok(issues >= 1);
  const row = byKey(results, 'git-filter-repo');
  assert.equal(row.ok, false);
  assert.match(row.fix, /git-filter-repo is not installed/);
});

// ── Key present but GitHub auth fails (the environment-not-Vector case) ───────
test('doctor: key present but GitHub auth fails → single [✗] listing all keys + the link', () => {
  const deps = greenDeps({
    platform: 'win32',
    listLocalSshKeys: () => ['id_ed25519.pub', 'id_rsa.pub'],
    githubCheck: () => ({ ok: false, reason: 'Permission denied (publickey).' }),
    fsutilAvailable: () => true,
  });
  const { results, ok } = runDoctorChecks(deps);
  assert.equal(ok, false);
  assert.equal(byKey(results, 'ssh-keys').ok, true, 'keys ARE present');
  const auth = byKey(results, 'github-auth');
  assert.equal(auth.ok, false);
  assert.match(auth.fix, /type %USERPROFILE%\\\.ssh\\id_ed25519\.pub/);
  assert.match(auth.fix, /type %USERPROFILE%\\\.ssh\\id_rsa\.pub/);
  assert.match(auth.fix, /https:\/\/github\.com\/settings\/keys/);

  // Exactly the auth row should be the failure that proves "environment, not Vector".
  const fails = results.filter((r) => !r.ok).map((r) => r.key);
  assert.deepEqual(fails, ['github-auth']);
});

// ── No keys at all ───────────────────────────────────────────────────────────
test('doctor: no keys → ssh-keys row fails with ssh-keygen guidance', () => {
  const { results, ok } = runDoctorChecks(greenDeps({
    listLocalSshKeys: () => [],
    findSshKey: () => ({ found: false }),
    githubCheck: () => ({ ok: false, reason: 'Permission denied (publickey).' }),
  }));
  assert.equal(ok, false);
  const keysRow = byKey(results, 'ssh-keys');
  assert.equal(keysRow.ok, false);
  assert.match(keysRow.fix, /ssh-keygen -t rsa -b 4096/);
});

// ── OS rendering (marks + fix commands + fsutil row) ─────────────────────────
test('doctor: Windows vs posix rendering', () => {
  assert.deepEqual(doctorMarks(true), { pass: '+', fail: 'x' });   // cmd-safe ASCII
  assert.deepEqual(doctorMarks(false), { pass: '✓', fail: '✗' });

  const win = runDoctorChecks(greenDeps({ platform: 'win32', fsutilAvailable: () => true,
    githubCheck: () => ({ ok: false, reason: 'Permission denied (publickey).' }) }));
  assert.ok(byKey(win.results, 'fsutil'), 'win32 includes the fsutil row');
  assert.match(byKey(win.results, 'github-auth').fix, /type %USERPROFILE%/);

  const nix = runDoctorChecks(greenDeps({ platform: 'linux',
    githubCheck: () => ({ ok: false, reason: 'Permission denied (publickey).' }) }));
  assert.equal(byKey(nix.results, 'fsutil'), undefined, 'posix omits the fsutil row');
  assert.match(byKey(nix.results, 'github-auth').fix, /cat ~\/\.ssh\//);

  // ASCII report uses [+]/[x]; unicode uses ✓/✗.
  const asciiReport = renderDoctorReport({ version: '2.2.0', nodeVersion: 'v22', platform: 'win32', results: win.results, useAscii: true });
  assert.match(asciiReport, /\[x\] GitHub SSH authentication/);
  assert.doesNotMatch(asciiReport, /✗/);
});

// ── Exit semantics via the orchestrator ──────────────────────────────────────
test('doctor(): returns ok:true and "all checks passed" when green; ok:false + summary when not', () => {
  const pass = doctor({ ...greenDeps(), version: '2.2.0', print: () => {} });
  assert.equal(pass.ok, true);
  assert.match(pass.report, /Result: all checks passed/);

  const fail = doctor({ ...greenDeps({ cwdWritable: () => false }), version: '2.2.0', print: () => {} });
  assert.equal(fail.ok, false);
  assert.match(fail.report, /Result: 1 issue\(s\) found/);
});
