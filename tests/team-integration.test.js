// End-to-end test of Team Migration mode against local bare repos standing in for
// Azure and GitHub — fully offline. Multiple branches, multiple authors, a
// committer≠author commit, partial mailmap (carol left unmapped). Proves:
// all-branches, author+committer rewrite, date/order preservation, idempotency,
// and non-destructive divergence handling (refuse without --force, overwrite with).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeConfig } from '../src/config.js';
import { migrate } from '../src/pipeline.js';

const hasTools =
  spawnSync('git', ['--version']).status === 0 &&
  spawnSync('git', ['filter-repo', '--version']).status === 0;

test('team migration: all branches, multi-developer rewrite, idempotent & non-destructive',
  { skip: hasTools ? false : 'git / git-filter-repo not installed' }, async () => {
  const WS = mkdtempSync(join(tmpdir(), 'vector-team-'));
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

  try {
    const WORK = join(WS, 'work');
    const AZ = join(WS, 'azure.git');
    const GH = join(WS, 'github.git');
    mkdirSync(WORK);
    sh(['-C', WORK, 'init', '-q']);
    sh(['-C', WORK, 'branch', '-M', 'main']);

    // main: alice, then bob
    commitAs(WORK, { an: 'Alice Old', ae: 'alice@oldcorp.com', date: '2020-01-01T00:00:00', msg: 'c1' });
    commitAs(WORK, { an: 'Bob Old', ae: 'bob@oldcorp.com', date: '2020-01-02T00:00:00', msg: 'c2' });
    // develop: carol (unmapped), then a commit authored by alice but COMMITTED by bob
    sh(['-C', WORK, 'checkout', '-q', '-b', 'develop']);
    commitAs(WORK, { an: 'Carol Ext', ae: 'carol@external.com', date: '2020-01-03T00:00:00', msg: 'd1' });
    commitAs(WORK, { an: 'Alice Old', ae: 'alice@oldcorp.com', cn: 'Bob Old', ce: 'bob@oldcorp.com', date: '2020-01-04T00:00:00', msg: 'd2' });
    // feature/x: bob
    sh(['-C', WORK, 'checkout', '-q', 'main']);
    sh(['-C', WORK, 'checkout', '-q', '-b', 'feature/x']);
    commitAs(WORK, { an: 'Bob Old', ae: 'bob@oldcorp.com', date: '2020-01-05T00:00:00', msg: 'f1' });

    sh(['clone', '-q', '--mirror', WORK, AZ]);
    sh(['init', '-q', '--bare', GH]);

    const mailmapPath = join(WS, 'team.mailmap');
    writeFileSync(mailmapPath,
      'Alice New <alice@newco.com> <alice@oldcorp.com>\n' +
      'Bob New <bob@newco.com> <bob@oldcorp.com>\n');
    const mailmapText = readFileSync(mailmapPath, 'utf8');

    const cfg = finalizeConfig({
      azureUrl: AZ, githubSsh: GH, project: 'team',
      teamMode: true, allBranches: true, mailmapText,
    }, { cwd: WS });

    const ghTip = (b) => { const o = sh(['ls-remote', GH, `refs/heads/${b}`]); return o ? o.split(/\s+/)[0] : ''; };
    const idMap = () => {
      const map = {};
      for (const line of bare(cfg.stagingMirror, ['log', '--all', '--format=%s\t%an\t%ae\t%cn\t%ce']).split('\n')) {
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

    // ── Run 1 — initial team migration ──
    const r1 = await migrate(cfg);
    assert.deepEqual(r1.branches, ['develop', 'feature/x', 'main'], 'all branches resolved (sorted)');
    assert.deepEqual(r1.pushes.map((p) => p.strategy), ['create', 'create', 'create'], 'every branch created');

    for (const b of ['main', 'develop', 'feature/x']) assert.ok(ghTip(b), `branch ${b} present on target`);

    const m = idMap();
    // every MAPPED commit has the new author AND committer identity
    assert.deepEqual(m.c1, { an: 'Alice New', ae: 'alice@newco.com', cn: 'Alice New', ce: 'alice@newco.com' }, 'c1 alice rewritten');
    assert.deepEqual(m.c2, { an: 'Bob New', ae: 'bob@newco.com', cn: 'Bob New', ce: 'bob@newco.com' }, 'c2 bob rewritten');
    assert.deepEqual(m.f1, { an: 'Bob New', ae: 'bob@newco.com', cn: 'Bob New', ce: 'bob@newco.com' }, 'f1 bob rewritten');
    // committer ≠ author commit: author=alice, committer=bob → both rewritten independently
    assert.deepEqual(m.d2, { an: 'Alice New', ae: 'alice@newco.com', cn: 'Bob New', ce: 'bob@newco.com' }, 'd2 author+committer rewritten');
    // unmapped author is untouched
    assert.deepEqual(m.d1, { an: 'Carol Ext', ae: 'carol@external.com', cn: 'Carol Ext', ce: 'carol@external.com' }, 'carol unchanged');
    // no old corporate email survives anywhere (author or committer)
    for (const e of Object.values(m)) {
      assert.ok(!/oldcorp\.com$/.test(e.ae) && !/oldcorp\.com$/.test(e.ce), `no oldcorp email remains (${e.ae}/${e.ce})`);
    }

    // dates & order preserved (compare epoch author/committer times source↔rewritten)
    const srcEpoch = epochMap(cfg.sourceMirror);
    const dstEpoch = epochMap(cfg.stagingMirror);
    for (const s of ['c1', 'c2', 'd1', 'd2', 'f1']) {
      assert.deepEqual(dstEpoch[s], srcEpoch[s], `commit ${s} keeps original author/committer dates`);
    }
    assert.deepEqual(bare(cfg.stagingMirror, ['log', 'main', '--format=%s']).split('\n'), ['c2', 'c1'], 'main order preserved');

    const tips1 = Object.fromEntries(['main', 'develop', 'feature/x'].map((b) => [b, ghTip(b)]));

    // ── Run 2 — idempotent: identical SHAs, nothing pushed ──
    const r2 = await migrate(cfg);
    assert.deepEqual(r2.pushes.map((p) => p.strategy), ['noop', 'noop', 'noop'], 're-run is a pure no-op');
    for (const b of ['main', 'develop', 'feature/x']) {
      assert.equal(ghTip(b), tips1[b], `branch ${b} SHA identical on re-run (idempotent)`);
    }

    // ── Run 3 — target 'main' diverges → must NOT clobber without --force ──
    const DV = join(WS, 'dv');
    sh(['clone', '-q', GH, DV]);
    sh(['-C', DV, 'checkout', '-q', 'main']);
    sh(['-C', DV, 'commit', '-q', '--amend', '--no-edit', '--allow-empty'], {
      env: { GIT_AUTHOR_NAME: 'X', GIT_AUTHOR_EMAIL: 'x@x.com', GIT_COMMITTER_NAME: 'X', GIT_COMMITTER_EMAIL: 'x@x.com', GIT_AUTHOR_DATE: '2021-01-01T00:00:00', GIT_COMMITTER_DATE: '2021-01-01T00:00:00' },
    });
    sh(['-C', DV, 'push', '-q', '-f', 'origin', 'main']);
    const divergedTip = ghTip('main');
    assert.notEqual(divergedTip, tips1.main, 'target main was artificially diverged');

    const r3 = await migrate(cfg);
    const main3 = r3.pushes.find((p) => p.branch === 'main');
    assert.equal(main3.strategy, 'diverged', 'a diverged branch is detected');
    assert.equal(ghTip('main'), divergedTip, 'diverged target is NOT overwritten without --force');

    // ── Run 4 — same divergence, with --force → overwrite as designed ──
    const r4 = await migrate({ ...cfg, force: true });
    const main4 = r4.pushes.find((p) => p.branch === 'main');
    assert.equal(main4.strategy, 'diverged', 'still classified as diverged');
    assert.equal(ghTip('main'), tips1.main, 'with --force the migrated history is restored');
  } finally {
    rmSync(WS, { recursive: true, force: true });
  }
});
