// End-to-end tests of the multi-mode pipeline against local bare repos standing in
// for the source and GitHub — fully offline. Covers Mode B (verbatim mirror,
// ref-equal), the 0-commit auto-fallback, sync determinism, the divergence stop,
// and the integrity engine catching a tampered destination.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeConfig } from '../src/config.js';
import { migrate, verifyIntegrity } from '../src/pipeline.js';
import { refTips, remoteRefTips } from '../src/git.js';

const hasTools =
  spawnSync('git', ['--version']).status === 0 &&
  spawnSync('git', ['filter-repo', '--version']).status === 0;

const skip = hasTools ? false : 'git / git-filter-repo not installed';

function harness() {
  const WS = mkdtempSync(join(tmpdir(), 'vector-modes-'));
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

/** Build a fake source repo with an old-corporate commit, a teammate commit, and a tag. */
function buildSource(h) {
  const WORK = join(h.WS, 'work');
  const SRC = join(h.WS, 'source.git');
  const GH = join(h.WS, 'github.git');
  mkdirSync(WORK);
  h.sh(['-C', WORK, 'init', '-q']);
  h.commit(WORK, 'Old Me', 'old@corp.example', '2020-01-01T00:00:00', 'c1');
  h.commit(WORK, 'Mate', 'mate@team.example', '2020-01-02T00:00:00', 'c2');
  h.sh(['-C', WORK, 'tag', 'v1.0']);
  h.sh(['-C', WORK, 'branch', '-M', 'master']);
  h.sh(['clone', '-q', '--mirror', WORK, SRC]);
  h.sh(['init', '-q', '--bare', GH]);
  return { WORK, SRC, GH };
}

test('Mode B — verbatim mirror: destination is ref-equal to source, nothing rewritten', { skip }, async () => {
  const h = harness();
  try {
    const { SRC, GH } = buildSource(h);
    const cfg = finalizeConfig({ mode: 'b', source: SRC, dest: GH, branches: [] }, { cwd: h.WS });
    assert.equal(cfg.baseStrategy, 'mirror');

    const r = await migrate(cfg);
    assert.equal(r.strategy, 'mirror', 'mirror strategy');
    assert.equal(r.rewrite.rewritten, false, 'no history rewrite in mirror mode');
    assert.equal(r.integrity.ok, true, 'integrity passes');

    // Every branch + tag on the destination matches the (unrewritten) staging mirror.
    const local = refTips(cfg.stagingMirror);
    const remote = remoteRefTips(GH);
    assert.deepEqual(remote, local, 'destination ref set + tips equal the source mirror');
    // The old corporate email is preserved verbatim (mirror does not rewrite).
    const emails = h.bare(cfg.stagingMirror, ['log', '--all', '--format=%ae']).split('\n');
    assert.ok(emails.includes('old@corp.example'), 'mirror keeps the original identities');
  } finally { h.done(); }
});

test('0-commit auto-fallback: a rewrite mapping matching no commits downgrades to mirror', { skip }, async () => {
  const h = harness();
  try {
    const { SRC, GH } = buildSource(h);
    // Mode A rewrite, but the old email is absent from history → must fall back to mirror.
    const cfg = finalizeConfig(
      { mode: 'a', source: SRC, dest: GH, oldEmail: 'ghost@absent.example', newName: 'octo', newEmail: 'me@personal.example', branches: [] },
      { cwd: h.WS },
    );
    assert.equal(cfg.baseStrategy, 'rewrite', 'starts as a rewrite');

    const r = await migrate(cfg);
    assert.equal(r.strategy, 'mirror', 'auto-fell-back to mirror');
    assert.ok(r.fallback && /0 commits/.test(r.fallback), 'reports why it fell back');
    assert.equal(r.integrity.ok, true);
    // Nothing was rewritten, so the original identities are intact on the destination.
    const emails = h.bare(cfg.stagingMirror, ['log', '--all', '--format=%ae']).split('\n');
    assert.ok(emails.includes('old@corp.example'));
  } finally { h.done(); }
});

test('Sync determinism: rewrite twice → identical OIDs and a no-op second push', { skip }, async () => {
  const h = harness();
  try {
    const { SRC, GH } = buildSource(h);
    const cfg = finalizeConfig(
      { mode: 'a', source: SRC, dest: GH, oldEmail: 'old@corp.example', newName: 'octo', newEmail: 'me@personal.example', branches: ['master'], sync: true },
      { cwd: h.WS },
    );

    const r1 = await migrate(cfg);
    assert.equal(r1.strategy, 'rewrite');
    assert.equal(r1.pushes[0].strategy, 'create');
    assert.equal(r1.integrity.ok, true);
    const tip1 = h.bare(cfg.stagingMirror, ['rev-parse', 'master']);

    const r2 = await migrate(cfg);
    assert.equal(r2.pushes[0].strategy, 'noop', 'second sync pushes nothing');
    assert.equal(r2.integrity.ok, true);
    const tip2 = h.bare(cfg.stagingMirror, ['rev-parse', 'master']);
    assert.equal(tip2, tip1, 'rewritten OIDs are byte-identical across runs (deterministic, append-only)');
    // The old corporate email is gone; the teammate is preserved.
    const emails = h.bare(cfg.stagingMirror, ['log', '--all', '--format=%ae']).split('\n');
    assert.ok(!emails.includes('old@corp.example'));
    assert.ok(emails.includes('mate@team.example'));
  } finally { h.done(); }
});

test('Divergence on --sync: an unrelated destination history stops with exit code 5', { skip }, async () => {
  const h = harness();
  try {
    const { SRC, GH } = buildSource(h);
    const mk = () => finalizeConfig(
      { mode: 'a', source: SRC, dest: GH, oldEmail: 'old@corp.example', newName: 'octo', newEmail: 'me@personal.example', branches: ['master'], sync: true },
      { cwd: h.WS },
    );
    await migrate(mk()); // seed the destination

    // Replace the destination master with an UNRELATED (orphan) history.
    const DV = join(h.WS, 'dv');
    h.sh(['clone', '-q', GH, DV]);
    h.sh(['-C', DV, 'checkout', '-q', '--orphan', 'fresh']);
    h.commit(DV, 'Someone', 'someone@github.example', '2021-01-01T00:00:00', 'unrelated-root');
    h.sh(['-C', DV, 'push', '-q', '-f', 'origin', 'fresh:master']);

    await assert.rejects(
      () => migrate(mk()),
      (e) => { assert.equal(e.exitCode, 5, 'divergence → exit 5'); assert.match(e.message, /DIVERGED/); return true; },
    );
  } finally { h.done(); }
});

test('Integrity engine catches a tampered destination ref', { skip }, async () => {
  const h = harness();
  try {
    const { SRC, GH } = buildSource(h);
    const cfg = finalizeConfig(
      { mode: 'a', source: SRC, dest: GH, oldEmail: 'old@corp.example', newName: 'octo', newEmail: 'me@personal.example', branches: ['master'] },
      { cwd: h.WS },
    );
    const r = await migrate(cfg);
    assert.equal(r.integrity.ok, true, 'clean migration passes integrity');

    // Tamper: roll the destination master back one commit, then re-verify.
    const parent = h.bare(cfg.stagingMirror, ['rev-parse', 'master^']);
    h.bare(GH, ['update-ref', 'refs/heads/master', parent]);
    const after = verifyIntegrity(cfg, { pushes: [{ branch: 'master', strategy: 'noop' }], tagPushes: [] });
    assert.equal(after.ok, false, 'a tampered/rolled-back destination is detected');
    assert.ok(after.mismatched.length > 0 || !after.countOk, 'reports the precise discrepancy');
  } finally { h.done(); }
});
