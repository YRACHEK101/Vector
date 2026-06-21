// End-to-end test of the unified workflow against local bare repos standing in
// for Azure and GitHub — fully offline. Same code path proves both the solo
// default (one identity mapped, rest kept) and the team case (more mappings).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeConfig } from '../src/config.js';
import { migrate } from '../src/pipeline.js';

const hasTools =
  spawnSync('git', ['--version']).status === 0 &&
  spawnSync('git', ['filter-repo', '--version']).status === 0;

const sh = (args, opts = {}) => {
  const r = spawnSync('git', args, { encoding: 'utf8', ...opts, env: { ...process.env, ...(opts.env || {}) } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}\n${r.stderr || r.stdout}`);
  return (r.stdout || '').trim();
};
const bare = (dir, args) => sh(['-c', 'safe.bareRepository=all', `--git-dir=${dir}`, ...args]);
const commitAs = (dir, { an, ae, cn, ce, date, msg }) =>
  sh(['-C', dir, 'commit', '-q', '--allow-empty', '-m', msg], {
    env: {
      GIT_AUTHOR_NAME: an, GIT_AUTHOR_EMAIL: ae,
      GIT_COMMITTER_NAME: cn ?? an, GIT_COMMITTER_EMAIL: ce ?? ae,
      GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date,
    },
  });

// A multi-branch, multi-author source incl. a committer≠author commit (d2).
function buildSource(WS) {
  const WORK = join(WS, 'work');
  const AZ = join(WS, 'azure.git');
  const GH = join(WS, 'github.git');
  mkdirSync(WORK);
  sh(['-C', WORK, 'init', '-q']);
  sh(['-C', WORK, 'branch', '-M', 'main']);
  commitAs(WORK, { an: 'Alice Old', ae: 'alice@oldcorp.com', date: '2020-01-01T00:00:00', msg: 'c1' });
  commitAs(WORK, { an: 'Bob Old', ae: 'bob@oldcorp.com', date: '2020-01-02T00:00:00', msg: 'c2' });
  sh(['-C', WORK, 'checkout', '-q', '-b', 'develop']);
  commitAs(WORK, { an: 'Carol Ext', ae: 'carol@external.com', date: '2020-01-03T00:00:00', msg: 'd1' });
  commitAs(WORK, { an: 'Alice Old', ae: 'alice@oldcorp.com', cn: 'Bob Old', ce: 'bob@oldcorp.com', date: '2020-01-04T00:00:00', msg: 'd2' });
  sh(['-C', WORK, 'checkout', '-q', 'main']);
  sh(['-C', WORK, 'checkout', '-q', '-b', 'feature/x']);
  commitAs(WORK, { an: 'Bob Old', ae: 'bob@oldcorp.com', date: '2020-01-05T00:00:00', msg: 'f1' });
  sh(['clone', '-q', '--mirror', WORK, AZ]);
  sh(['init', '-q', '--bare', GH]);
  return { AZ, GH };
}

const ghTip = (GH, b) => { const o = sh(['ls-remote', GH, `refs/heads/${b}`]); return o ? o.split(/\s+/)[0] : ''; };
const idMap = (dir) => {
  const map = {};
  for (const line of bare(dir, ['log', '--all', '--format=%s\t%an\t%ae\t%cn\t%ce']).split('\n')) {
    if (!line) continue;
    const [s, an, ae, cn, ce] = line.split('\t');
    map[s] = { an, ae, cn, ce };
  }
  return map;
};
const epochMap = (dir) => {
  const map = {};
  for (const line of bare(dir, ['log', '--all', '--format=%s\t%at\t%ct']).split('\n')) {
    if (!line) continue;
    const [s, at, ct] = line.split('\t');
    map[s] = { at, ct };
  }
  return map;
};

// ── Case A — solo, the default path: map ONLY Alice, keep Bob & Carol ────────
test('Case A — solo default: only Alice mapped; all branches; idempotent & non-destructive',
  { skip: hasTools ? false : 'git / git-filter-repo not installed' }, async () => {
  const WS = mkdtempSync(join(tmpdir(), 'vector-a-'));
  try {
    const { AZ, GH } = buildSource(WS);
    const cfg = finalizeConfig({
      azureUrl: AZ, githubSsh: GH, project: 'solo', allBranches: true,
      mailmapText: 'Alice New <alice@newco.com> <alice@oldcorp.com>\n',
    }, { cwd: WS });

    const r1 = await migrate(cfg);
    assert.deepEqual(r1.branches, ['develop', 'feature/x', 'main'], 'all branches resolved');
    assert.deepEqual(r1.pushes.map((p) => p.strategy), ['create', 'create', 'create'], 'all branches created on target');
    for (const b of ['main', 'develop', 'feature/x']) assert.ok(ghTip(GH, b), `branch ${b} present on target`);

    const m = idMap(cfg.stagingMirror);
    // Alice's commit: BOTH author and committer rewritten
    assert.deepEqual(m.c1, { an: 'Alice New', ae: 'alice@newco.com', cn: 'Alice New', ce: 'alice@newco.com' }, 'Alice author+committer rewritten');
    // committer≠author: Alice (author) rewritten, Bob (committer) KEPT (unmapped in solo)
    assert.deepEqual(m.d2, { an: 'Alice New', ae: 'alice@newco.com', cn: 'Bob Old', ce: 'bob@oldcorp.com' }, 'only Alice rewritten on mixed commit');
    // Bob & Carol untouched
    assert.deepEqual(m.c2, { an: 'Bob Old', ae: 'bob@oldcorp.com', cn: 'Bob Old', ce: 'bob@oldcorp.com' }, 'Bob unchanged');
    assert.deepEqual(m.d1, { an: 'Carol Ext', ae: 'carol@external.com', cn: 'Carol Ext', ce: 'carol@external.com' }, 'Carol unchanged');

    // dates/order preserved
    const src = epochMap(cfg.sourceMirror); const dst = epochMap(cfg.stagingMirror);
    for (const s of ['c1', 'c2', 'd1', 'd2', 'f1']) assert.deepEqual(dst[s], src[s], `commit ${s} keeps dates`);
    assert.deepEqual(bare(cfg.stagingMirror, ['log', 'main', '--format=%s']), 'c2\nc1', 'main order preserved');

    // idempotent: identical SHAs, nothing pushed
    const tips1 = Object.fromEntries(['main', 'develop', 'feature/x'].map((b) => [b, ghTip(GH, b)]));
    const r2 = await migrate(cfg);
    assert.deepEqual(r2.pushes.map((p) => p.strategy), ['noop', 'noop', 'noop'], 're-run is a no-op');
    for (const b of ['main', 'develop', 'feature/x']) assert.equal(ghTip(GH, b), tips1[b], `${b} SHA identical on re-run`);

    // non-destructive: diverged target main is NOT clobbered without --force
    const DV = join(WS, 'dv');
    sh(['clone', '-q', GH, DV]);
    sh(['-C', DV, 'checkout', '-q', 'main']);
    sh(['-C', DV, 'commit', '-q', '--amend', '--no-edit', '--allow-empty'], {
      env: { GIT_AUTHOR_NAME: 'X', GIT_AUTHOR_EMAIL: 'x@x.com', GIT_COMMITTER_NAME: 'X', GIT_COMMITTER_EMAIL: 'x@x.com', GIT_AUTHOR_DATE: '2021-01-01T00:00:00', GIT_COMMITTER_DATE: '2021-01-01T00:00:00' },
    });
    sh(['-C', DV, 'push', '-q', '-f', 'origin', 'main']);
    const diverged = ghTip(GH, 'main');
    const r3 = await migrate(cfg);
    assert.equal(r3.pushes.find((p) => p.branch === 'main').strategy, 'diverged', 'divergence detected');
    assert.equal(ghTip(GH, 'main'), diverged, 'diverged target not overwritten without --force');
  } finally {
    rmSync(WS, { recursive: true, force: true });
  }
});

// ── Case B — team, same flow with more mappings: Alice + Bob, skip Carol ─────
test('Case B — team: Alice & Bob mapped (author+committer), Carol kept; all branches; idempotent',
  { skip: hasTools ? false : 'git / git-filter-repo not installed' }, async () => {
  const WS = mkdtempSync(join(tmpdir(), 'vector-b-'));
  try {
    const { AZ, GH } = buildSource(WS);
    const cfg = finalizeConfig({
      azureUrl: AZ, githubSsh: GH, project: 'team', allBranches: true,
      mailmapText: 'Alice New <alice@newco.com> <alice@oldcorp.com>\nBob New <bob@newco.com> <bob@oldcorp.com>\n',
    }, { cwd: WS });

    const r1 = await migrate(cfg);
    assert.deepEqual(r1.branches, ['develop', 'feature/x', 'main'], 'all branches transferred');
    for (const b of ['main', 'develop', 'feature/x']) assert.ok(ghTip(GH, b), `branch ${b} present`);

    const m = idMap(cfg.stagingMirror);
    assert.deepEqual(m.c1, { an: 'Alice New', ae: 'alice@newco.com', cn: 'Alice New', ce: 'alice@newco.com' });
    assert.deepEqual(m.c2, { an: 'Bob New', ae: 'bob@newco.com', cn: 'Bob New', ce: 'bob@newco.com' });
    // committer≠author: BOTH Alice (author) and Bob (committer) rewritten now
    assert.deepEqual(m.d2, { an: 'Alice New', ae: 'alice@newco.com', cn: 'Bob New', ce: 'bob@newco.com' }, 'both mapped on mixed commit');
    assert.deepEqual(m.d1, { an: 'Carol Ext', ae: 'carol@external.com', cn: 'Carol Ext', ce: 'carol@external.com' }, 'Carol kept');
    for (const e of Object.values(m)) {
      assert.ok(!/oldcorp\.com$/.test(e.ae) && !/oldcorp\.com$/.test(e.ce), `no oldcorp email remains (${e.ae}/${e.ce})`);
    }

    const tips1 = Object.fromEntries(['main', 'develop', 'feature/x'].map((b) => [b, ghTip(GH, b)]));
    const r2 = await migrate(cfg);
    assert.deepEqual(r2.pushes.map((p) => p.strategy), ['noop', 'noop', 'noop'], 'idempotent re-run');
    for (const b of ['main', 'develop', 'feature/x']) assert.equal(ghTip(GH, b), tips1[b], `${b} identical on re-run`);
  } finally {
    rmSync(WS, { recursive: true, force: true });
  }
});
