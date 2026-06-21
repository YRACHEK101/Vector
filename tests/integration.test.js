// End-to-end test of the REAL pipeline (src/pipeline.js) against local bare repos
// standing in for Azure and GitHub — fully offline. Verifies the incremental,
// idempotent, non-destructive guarantees: create → noop → fast-forward → never
// overwrite when the remote diverges.
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

test('incremental migration against local stand-in repos', { skip: hasTools ? false : 'git / git-filter-repo not installed' }, async () => {
  const WS = mkdtempSync(join(tmpdir(), 'vector-it-'));
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

  try {
    // ── Build a fake Azure source: old-corporate-email commit + a teammate commit ──
    const WORK = join(WS, 'work');
    const AZ = join(WS, 'azure.git');
    const GH = join(WS, 'github.git');
    mkdirSync(WORK);
    sh(['-C', WORK, 'init', '-q']);
    commit(WORK, 'Old Me', 'old@corp.example', '2020-01-01T00:00:00', 'c1');
    commit(WORK, 'Mate', 'mate@team.example', '2020-01-02T00:00:00', 'c2');
    sh(['-C', WORK, 'branch', '-M', 'master']);
    sh(['clone', '-q', '--mirror', WORK, AZ]);
    sh(['init', '-q', '--bare', GH]);

    const cfg = finalizeConfig(
      { azureUrl: AZ, githubSsh: GH, oldEmail: 'old@corp.example', newName: 'octocat', newEmail: 'me@personal.example', branches: ['master'] },
      { cwd: WS },
    );

    const ghMaster = () => { const o = sh(['ls-remote', GH, 'refs/heads/master']); return o ? o.split(/\s+/)[0] : ''; };
    const c1sha = () => {
      for (const line of bare(cfg.stagingMirror, ['log', 'master', '--format=%H|%s']).split('\n')) {
        const [h, s] = line.split('|'); if (s === 'c1') return h;
      }
      return '';
    };
    const isAncestor = (a, b) => spawnSync('git', ['-c', 'safe.bareRepository=all', `--git-dir=${cfg.stagingMirror}`, 'merge-base', '--is-ancestor', a, b]).status === 0;

    // ── Run 1 — initial migration ──
    const r1 = await migrate(cfg);
    assert.equal(r1.mode, 'initial', 'first run mirror-clones the source');
    assert.equal(r1.rewrite.rewritten, true, 'history is rewritten');
    assert.equal(r1.pushes[0].strategy, 'create', 'branch is created on GitHub');
    const ids = bare(cfg.stagingMirror, ['log', '--all', '--format=%ae']).split('\n');
    assert.ok(!ids.includes('old@corp.example'), 'old corporate email is purged');
    assert.ok(ids.includes('mate@team.example'), 'teammate identity is preserved');
    const gh1 = ghMaster();
    const rw1 = c1sha();

    // ── Run 2 — re-run with no Azure changes (idempotent, reuses existing mirror) ──
    const r2 = await migrate(cfg);
    assert.equal(r2.mode, 'incremental', 'second run reuses the existing source mirror');
    assert.equal(r2.pushes[0].strategy, 'noop', 're-run pushes nothing');
    assert.equal(ghMaster(), gh1, 'GitHub is left unchanged on a no-op run');

    // ── Run 3 — new Azure commit → incremental fast-forward ──
    commit(WORK, 'Old Me', 'old@corp.example', '2020-03-01T00:00:00', 'c3');
    sh(['-C', WORK, 'push', '-q', AZ, 'master']);
    const r3 = await migrate(cfg);
    assert.equal(r3.pushes[0].strategy, 'fast-forward', 'only the delta is fast-forwarded');
    assert.equal(c1sha(), rw1, 'rewritten SHAs are deterministic across runs');
    const gh3 = ghMaster();
    assert.ok(isAncestor(gh1, gh3), 'prior GitHub history is preserved (old tip is an ancestor)');

    // ── Run 4 — remote diverges (a commit lands only on GitHub) → must NOT overwrite ──
    const DV = join(WS, 'dv');
    sh(['clone', '-q', GH, DV]);
    sh(['-C', DV, 'checkout', '-q', 'master']);
    commit(DV, 'Someone', 'someone@github.example', '2020-04-01T00:00:00', 'github-only');
    sh(['-C', DV, 'push', '-q', 'origin', 'master']);
    const ghd = ghMaster();
    const r4 = await migrate(cfg);
    assert.equal(r4.pushes[0].strategy, 'remote-ahead', 'a diverged/ahead remote is never overwritten');
    assert.equal(ghMaster(), ghd, 'GitHub history is left fully intact');
  } finally {
    rmSync(WS, { recursive: true, force: true });
  }
});
