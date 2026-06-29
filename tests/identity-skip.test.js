// End-to-end tests of identity SKIP vs MATCH against local bare repos standing in
// for the source and GitHub — fully offline. Verifies that skipping identity
// rewriting preserves every author/committer exactly, and that a matched plan
// still rewrites only the matched author.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeConfig } from '../src/config.js';
import { migrate } from '../src/pipeline.js';
import { entriesToMailmap, planIdentityMatch } from '../src/team.js';

const hasTools =
  spawnSync('git', ['--version']).status === 0 &&
  spawnSync('git', ['filter-repo', '--version']).status === 0;
const skip = hasTools ? false : 'git / git-filter-repo not installed';

function harness() {
  const WS = mkdtempSync(join(tmpdir(), 'vector-id-'));
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
  // Sorted, unique "name|email" across BOTH author and committer, over all refs.
  const idMeta = (dir) => {
    const a = bare(dir, ['log', '--all', '--format=%an|%ae']).split('\n');
    const c = bare(dir, ['log', '--all', '--format=%cn|%ce']).split('\n');
    return [...new Set([...a, ...c].filter(Boolean))].sort();
  };
  return { WS, sh, bare, commit, idMeta, done: () => rmSync(WS, { recursive: true, force: true }) };
}

function buildSource(h) {
  const WORK = join(h.WS, 'work');
  const SRC = join(h.WS, 'source.git');
  const GH = join(h.WS, 'github.git');
  mkdirSync(WORK);
  h.sh(['-C', WORK, 'init', '-q']);
  h.commit(WORK, 'Old Me', 'old@corp.example', '2020-01-01T00:00:00', 'c1');
  h.commit(WORK, 'Mate', 'mate@team.example', '2020-01-02T00:00:00', 'c2');
  h.sh(['-C', WORK, 'branch', '-M', 'master']);
  h.sh(['clone', '-q', '--mirror', WORK, SRC]);
  h.sh(['init', '-q', '--bare', GH]);
  return { SRC, GH };
}

test('skip identity: all authors preserved, metadata identical to source', { skip }, async () => {
  const h = harness();
  try {
    const { SRC, GH } = buildSource(h);
    // Rewrite mode (a) but the operator isn't a contributor → skipIdentity resolved.
    const cfg = finalizeConfig({ mode: 'a', source: SRC, dest: GH, skipIdentity: true, branches: ['master'] }, { cwd: h.WS });
    const r = await migrate(cfg);

    assert.equal(r.skippedIdentity, true, 'identity rewrite was skipped');
    assert.equal(r.strategy, 'mirror', 'fell through to a plain mirror');
    assert.equal(r.rewrite.rewritten, false, 'no git-filter-repo identity pass ran');

    const src = h.idMeta(SRC);
    const dest = h.idMeta(GH);
    assert.deepEqual(dest, src, 'destination author/committer metadata is identical to the source');
    assert.ok(dest.includes('Old Me|old@corp.example'), 'original author kept');
    assert.ok(dest.includes('Mate|mate@team.example'), 'teammate kept');
  } finally { h.done(); }
});

test('matched plan: only the matched author is rewritten, others preserved', { skip }, async () => {
  const h = harness();
  try {
    const { SRC, GH } = buildSource(h);
    const identities = [
      { name: 'Old Me', email: 'old@corp.example' },
      { name: 'Mate', email: 'mate@team.example' },
    ];
    // The operator declares themselves via --me (matched), with a new identity.
    const plan = planIdentityMatch({ identities, me: 'old@corp.example', newName: 'New Me', newEmail: 'me@personal.example' });
    assert.equal(plan.skip, false);

    const cfg = finalizeConfig(
      { mode: 'a', source: SRC, dest: GH, mailmapText: entriesToMailmap(plan.entries), branches: ['master'] },
      { cwd: h.WS },
    );
    const r = await migrate(cfg);

    assert.equal(r.skippedIdentity, false);
    assert.equal(r.strategy, 'rewrite');
    const dest = h.idMeta(GH);
    assert.ok(!dest.some((m) => m.endsWith('|old@corp.example')), 'matched author rewritten away');
    assert.ok(dest.includes('New Me|me@personal.example'), 'new identity present');
    assert.ok(dest.includes('Mate|mate@team.example'), 'teammate untouched');
  } finally { h.done(); }
});

test('--skip-identity beats a would-be match: nothing is rewritten', { skip }, async () => {
  const h = harness();
  try {
    const { SRC, GH } = buildSource(h);
    // Even though old@corp.example WOULD match, --skip-identity forces a mirror.
    const cfg = finalizeConfig(
      { mode: 'a', source: SRC, dest: GH, skipIdentity: true, newName: 'X', newEmail: 'old@corp.example', branches: ['master'] },
      { cwd: h.WS },
    );
    const r = await migrate(cfg);
    assert.equal(r.skippedIdentity, true);
    assert.deepEqual(h.idMeta(GH), h.idMeta(SRC));
  } finally { h.done(); }
});
