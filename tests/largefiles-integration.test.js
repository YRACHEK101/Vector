// End-to-end tests of the large-file pre-flight + remediation against local bare
// repos standing in for the source and GitHub — fully offline. A repo with an
// oversized blob in history must migrate end-to-end (strip by default), with the
// blob absent from the pushed history, and the scan must run BEFORE the push.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeConfig } from '../src/config.js';
import { migrate, lfsMigrateImport } from '../src/pipeline.js';
import { scanLargeBlobs, mbToBytes, gitLfsAvailable } from '../src/largefiles.js';

const hasTools =
  spawnSync('git', ['--version']).status === 0 &&
  spawnSync('git', ['filter-repo', '--version']).status === 0;
const skip = hasTools ? false : 'git / git-filter-repo not installed';

function harness() {
  const WS = mkdtempSync(join(tmpdir(), 'vector-lf-'));
  const sh = (args, opts = {}) => {
    const r = spawnSync('git', args, { encoding: 'utf8', ...opts, env: { ...process.env, ...(opts.env || {}) } });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}\n${r.stderr || r.stdout}`);
    return (r.stdout || '').trim();
  };
  const bare = (dir, args) => sh(['-c', 'safe.bareRepository=all', `--git-dir=${dir}`, ...args]);
  const commit = (dir, name, email, date, msg) =>
    sh(['-C', dir, 'commit', '-q', '--allow-empty', '-m', msg], {
      env: { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
  return { WS, sh, bare, commit, done: () => rmSync(WS, { recursive: true, force: true }) };
}

const BIG = 'Cursor.AppImage';     // the oversized offender (2 MiB), limit set to 1 MB
const SMALL = 'README.md';

/** Build a source repo: a small commit, then a 2 MiB blob committed by an old email. */
function buildSourceWithBigFile(h) {
  const WORK = join(h.WS, 'work');
  const SRC = join(h.WS, 'source.git');
  const GH = join(h.WS, 'github.git');
  mkdirSync(WORK);
  h.sh(['-C', WORK, 'init', '-q']);
  writeFileSync(join(WORK, SMALL), '# project\n');
  h.sh(['-C', WORK, 'add', SMALL]);
  h.commit(WORK, 'Old Me', 'old@corp.example', '2020-01-01T00:00:00', 'c1: readme');
  writeFileSync(join(WORK, BIG), Buffer.alloc(2 * 1024 * 1024, 0x61)); // 2 MiB of 'a'
  h.sh(['-C', WORK, 'add', BIG]);
  h.commit(WORK, 'Old Me', 'old@corp.example', '2020-01-02T00:00:00', 'c2: add big binary');
  h.sh(['-C', WORK, 'branch', '-M', 'master']);
  h.sh(['clone', '-q', '--mirror', WORK, SRC]);
  h.sh(['init', '-q', '--bare', GH]);
  return { WORK, SRC, GH };
}

const tipFiles = (h, bareDir, branch = 'master') =>
  h.bare(bareDir, ['ls-tree', '-r', '--name-only', branch]).split('\n').filter(Boolean);

test('mirror mode + strip (force): oversized blob removed, push succeeds, scan precedes push', { skip }, async () => {
  const h = harness();
  try {
    const { SRC, GH } = buildSourceWithBigFile(h);
    // Spy UI to assert the scan/report happens BEFORE the push.
    const order = [];
    const rec = (kind) => (m) => { if (m) order.push(`${kind}:${m}`); };
    const ui = { step: rec('step'), info: rec('info'), ok: rec('ok'), warn: rec('warn'),
      spinner: (t) => ({ start() { order.push(`spin:${t}`); return this; }, succeed: rec('ok'), fail: rec('warn'), stop() { return this; } }) };

    const cfg = finalizeConfig(
      { mode: 'b', source: SRC, dest: GH, branches: ['master'], maxFileSize: '1', onLargeFile: 'strip', force: true },
      { cwd: h.WS },
    );
    const r = await migrate(cfg, ui);

    assert.equal(r.largeFiles.offenders.length, 1, 'one offender detected');
    assert.equal(r.largeFiles.offenders[0].path, BIG);
    assert.equal(r.remediation.remediated, true);
    assert.equal(r.remediation.mode, 'strip');
    assert.equal(r.pushes[0].strategy, 'create', 'branch pushed to destination');

    // The big file is gone from the pushed history; the small file survives.
    const dest = tipFiles(h, GH);
    assert.ok(!dest.includes(BIG), 'oversized file absent from destination');
    assert.ok(dest.includes(SMALL), 'normal file preserved');
    const remaining = await scanLargeBlobs(GH, mbToBytes(1), { env: cfg.gitEnv });
    assert.equal(remaining.length, 0, 'no oversized blobs remain anywhere in destination history');

    // Ordering: the size scan ran before any push line.
    const scanIdx = order.findIndex((l) => /Scanning history for files/.test(l));
    const pushIdx = order.findIndex((l) => /created on the destination/.test(l));
    assert.ok(scanIdx >= 0 && pushIdx >= 0 && scanIdx < pushIdx, 'pre-flight scan precedes the push');
  } finally { h.done(); }
});

test('rewrite mode + strip folded into the single filter-repo pass', { skip }, async () => {
  const h = harness();
  try {
    const { SRC, GH } = buildSourceWithBigFile(h);
    const cfg = finalizeConfig(
      { source: SRC, dest: GH, oldEmail: 'old@corp.example', newName: 'octocat', newEmail: 'me@personal.example',
        branches: ['master'], maxFileSize: '1', onLargeFile: 'strip', force: true },
      { cwd: h.WS },
    );
    const r = await migrate(cfg);

    assert.equal(r.strategy, 'rewrite', 'identity rewrite ran');
    assert.equal(r.rewrite.stripped, true, 'strip folded into the rewrite pass');
    assert.equal(r.remediation.remediated, true);

    // Identity rewritten AND big file gone — both in one pass.
    const emails = h.bare(cfg.stagingMirror, ['log', '--all', '--format=%ae']).split('\n');
    assert.ok(!emails.includes('old@corp.example'), 'old email purged');
    assert.ok(!tipFiles(h, GH).includes(BIG), 'oversized file absent from destination');
    const remaining = await scanLargeBlobs(cfg.stagingMirror, mbToBytes(1), { env: cfg.gitEnv });
    assert.equal(remaining.length, 0);
  } finally { h.done(); }
});

test('abort mode: stops before any push, destination untouched', { skip }, async () => {
  const h = harness();
  try {
    const { SRC, GH } = buildSourceWithBigFile(h);
    const cfg = finalizeConfig(
      { mode: 'b', source: SRC, dest: GH, branches: ['master'], maxFileSize: '1', onLargeFile: 'abort' },
      { cwd: h.WS },
    );
    await assert.rejects(migrate(cfg), (e) => {
      assert.match(e.message, /exceed GitHub's 1 MB limit/);
      assert.match(e.message, /--on-large-file strip/);
      return true;
    });
    // Nothing was pushed.
    const refs = h.sh(['ls-remote', GH]);
    assert.equal(refs, '', 'destination has no refs — push never happened');
  } finally { h.done(); }
});

test('no oversized files: behaviour unchanged, no remediation', { skip }, async () => {
  const h = harness();
  try {
    // A normal small repo (no big blob).
    const WORK = join(h.WS, 'work');
    const SRC = join(h.WS, 'source.git');
    const GH = join(h.WS, 'github.git');
    mkdirSync(WORK);
    h.sh(['-C', WORK, 'init', '-q']);
    h.commit(WORK, 'Old Me', 'old@corp.example', '2020-01-01T00:00:00', 'c1');
    h.sh(['-C', WORK, 'branch', '-M', 'master']);
    h.sh(['clone', '-q', '--mirror', WORK, SRC]);
    h.sh(['init', '-q', '--bare', GH]);

    const cfg = finalizeConfig(
      { source: SRC, dest: GH, oldEmail: 'old@corp.example', newName: 'octocat', newEmail: 'me@personal.example', branches: ['master'] },
      { cwd: h.WS },
    );
    const r = await migrate(cfg);
    assert.equal(r.largeFiles.offenders.length, 0, 'no offenders');
    assert.equal(r.largeFiles.action, 'none');
    assert.equal(r.remediation.remediated, false, 'no remediation performed');
    assert.equal(r.pushes[0].strategy, 'create', 'migration proceeds exactly as before');
  } finally { h.done(); }
});

test('GH001 fallback: a push rejected for an oversized file gets a readable message, not a raw exit code', { skip }, async () => {
  const h = harness();
  try {
    // A normal small repo, but the remote rejects the push with a GH001 error —
    // proving the tee-captured stderr is recognised and translated.
    const WORK = join(h.WS, 'work');
    const SRC = join(h.WS, 'source.git');
    const GH = join(h.WS, 'github.git');
    mkdirSync(WORK);
    h.sh(['-C', WORK, 'init', '-q']);
    h.commit(WORK, 'Old Me', 'old@corp.example', '2020-01-01T00:00:00', 'c1');
    h.sh(['-C', WORK, 'branch', '-M', 'master']);
    h.sh(['clone', '-q', '--mirror', WORK, SRC]);
    h.sh(['init', '-q', '--bare', GH]);
    const hook = join(GH, 'hooks', 'pre-receive');
    writeFileSync(hook,
      '#!/bin/sh\n'
      + 'echo "error: File Cursor.AppImage is 182.19 MB; this exceeds GitHub\'s file size limit of 100.00 MB" 1>&2\n'
      + 'echo "error: GH001: Large files detected." 1>&2\n'
      + 'exit 1\n');
    chmodSync(hook, 0o755);

    const cfg = finalizeConfig(
      { mode: 'b', source: SRC, dest: GH, branches: ['master'], skipLargeFileScan: true },
      { cwd: h.WS },
    );
    await assert.rejects(migrate(cfg), (e) => {
      assert.match(e.message, /exceed/i);
      assert.match(e.message, /--on-large-file strip/);
      assert.match(e.message, /--max-file-size/);
      assert.doesNotMatch(e.message, /exited with code/, 'raw exit-code message is replaced');
      assert.equal(e.exitCode, 3, 'surfaces a git-failure exit code');
      return true;
    });
  } finally { h.done(); }
});

test('lfs migration removes the oversized blob from history (git-lfs required)', { skip: skip || (gitLfsAvailable() ? false : 'git-lfs not installed') }, async () => {
  // Exercises the real `git lfs migrate import` step directly. The subsequent push
  // of LFS objects needs an LFS server (GitHub has one); a local file:// bare repo
  // does not, so we verify the history rewrite here rather than the offline push.
  const h = harness();
  try {
    const { SRC } = buildSourceWithBigFile(h);
    const STAGING = join(h.WS, 'staging.git');
    h.sh(['clone', '-q', '--mirror', SRC, STAGING]);
    const cfg = { stagingMirror: STAGING, gitEnv: {} };
    assert.equal((await scanLargeBlobs(STAGING, mbToBytes(1), { env: cfg.gitEnv })).length, 1, 'big blob present before');
    await lfsMigrateImport(cfg, 1);
    const remaining = await scanLargeBlobs(STAGING, mbToBytes(1), { env: cfg.gitEnv });
    assert.equal(remaining.length, 0, 'no oversized blobs remain after LFS migration (replaced by pointers)');
  } finally { h.done(); }
});

test('lfs requested but git-lfs missing: auto/force run falls back to strip and completes', { skip }, async () => {
  const h = harness();
  try {
    const { SRC, GH } = buildSourceWithBigFile(h);
    const cfg = finalizeConfig(
      { mode: 'b', source: SRC, dest: GH, branches: ['master'], maxFileSize: '1', onLargeFile: 'lfs', force: true },
      { cwd: h.WS },
    );
    cfg._lfsAvailable = false; // simulate git-lfs not installed
    const r = await migrate(cfg);
    assert.equal(r.remediation.mode, 'strip', 'fell back to strip when git-lfs is absent');
    assert.equal(r.pushes[0].strategy, 'create', 'migration still completes');
    assert.ok(!tipFiles(h, GH).includes(BIG), 'oversized file absent from destination');
  } finally { h.done(); }
});

test('lfs requested but git-lfs missing: interactive run aborts with install guidance', { skip }, async () => {
  const h = harness();
  try {
    const { SRC, GH } = buildSourceWithBigFile(h);
    const cfg = finalizeConfig(
      { mode: 'b', source: SRC, dest: GH, branches: ['master'], maxFileSize: '1', onLargeFile: 'lfs' },
      { cwd: h.WS },
    );
    cfg._lfsAvailable = false;
    cfg._chooseLargeFileAction = async () => 'lfs'; // marks the run as interactive
    await assert.rejects(migrate(cfg), /needs git-lfs/);
    assert.equal(h.sh(['ls-remote', GH]), '', 'nothing pushed');
  } finally { h.done(); }
});
