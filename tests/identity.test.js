// Identity remapping (name-only / email / unify) + idempotent & --force-existing
// migration. Pure unit tests always run; the end-to-end tests run the REAL pipeline
// against local bare repos (offline) and are gated on git + git-filter-repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeConfig } from '../src/config.js';
import {
  migrate, validateMappings, mappingsApplicable, summarizePushes, formatPushSummary,
} from '../src/pipeline.js';

// ── Pure: per-mapping safety check ───────────────────────────────────────────
test('validateMappings: name-only remap (email kept) passes; email change still verified', () => {
  // (1) name-only, fully unified → no error
  assert.deepEqual(validateMappings(
    [{ name: 'YRACHEK101', email: 'y@liad.com' }],
    [{ name: 'YRACHEK101', email: 'y@liad.com', sourceEmail: 'y@liad.com' }]), []);
  // a stray old name for that email → error (not yet unified)
  assert.equal(validateMappings(
    [{ name: 'YRACHEK101', email: 'y@liad.com' }, { name: 'yRachek', email: 'y@liad.com' }],
    [{ name: 'YRACHEK101', email: 'y@liad.com', sourceEmail: 'y@liad.com' }]).length, 1);
  // (2) email change: old email gone → ok; still present → error
  assert.deepEqual(validateMappings(
    [{ name: 'Me', email: 'new@x.com' }],
    [{ name: 'Me', email: 'new@x.com', sourceEmail: 'old@corp.com' }]), []);
  assert.equal(validateMappings(
    [{ name: 'Me', email: 'old@corp.com' }],
    [{ name: 'Me', email: 'new@x.com', sourceEmail: 'old@corp.com' }]).length, 1);
  // never fails just because the canonical/new identity legitimately exists
  assert.deepEqual(validateMappings(
    [{ name: 'Canon', email: 'c@x.com' }],
    [{ name: 'Canon', email: 'c@x.com', sourceEmail: 'c@x.com' }]), []);
});

test('mappingsApplicable: true only when a source identity is present', () => {
  const ids = [{ name: 'Dev', email: 'd@corp.com' }];
  assert.equal(mappingsApplicable(ids, [{ name: 'New', email: 'd@corp.com', sourceEmail: 'd@corp.com' }]), true); // name differs
  assert.equal(mappingsApplicable(ids, [{ name: 'X', email: 'n@x.com', sourceEmail: 'absent@x.com' }]), false);   // source not here
  assert.equal(mappingsApplicable([{ name: 'New', email: 'd@corp.com' }],
    [{ name: 'New', email: 'd@corp.com', sourceEmail: 'd@corp.com' }]), false); // already canonical → nothing to do
});

// ── Pure: push summary ───────────────────────────────────────────────────────
test('summarizePushes / formatPushSummary categorize outcomes', () => {
  const b = summarizePushes([
    { branch: 'a', strategy: 'create' }, { branch: 'master', strategy: 'noop' },
    { branch: 'r', strategy: 'diverged', forced: false }, { branch: 'q', strategy: 'diverged', forced: true },
  ]);
  assert.deepEqual(b.created, ['a']);
  assert.deepEqual(b.upToDate, ['master']);
  assert.deepEqual(b.differs, ['r']);
  assert.deepEqual(b.forceUpdated, ['q']);
  assert.match(formatPushSummary([{ branch: 'a', strategy: 'create' }, { branch: 'master', strategy: 'noop' }]),
    /Pushed: 1 new · Skipped \(already present\): 1 \(master\) · Differs \(use --force-existing\): 0/);
});

// ── Integration harness (local stand-ins for Azure + GitHub) ─────────────────
const hasTools = spawnSync('git', ['--version']).status === 0
  && spawnSync('git', ['filter-repo', '--version']).status === 0;

const sh = (args, opts = {}) => {
  const r = spawnSync('git', args, { encoding: 'utf8', ...opts, env: { ...process.env, ...(opts.env || {}) } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}\n${r.stderr || r.stdout}`);
  return (r.stdout || '').trim();
};
const bare = (dir, args) => sh(['-c', 'safe.bareRepository=all', `--git-dir=${dir}`, ...args]);
const commit = (dir, name, email, date, msg) => sh(['-C', dir, 'commit', '-q', '--allow-empty', '-m', msg],
  { env: { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
const ghSha = (GH, b = 'master') => { const o = sh(['ls-remote', GH, `refs/heads/${b}`]); return o ? o.split(/\s+/)[0] : ''; };
// Read only the migrated branches (refs/heads via --branches), NOT the scratch
// refs/vector/remote/* that pushBranch creates to do local ancestry checks.
const stagingNames = (cfg, email) => [...new Set(bare(cfg.stagingMirror, ['log', '--branches', '--format=%aN|%aE'])
  .split('\n').map((l) => l.trim()).filter(Boolean)
  .filter((l) => l.toLowerCase().endsWith(`|${email.toLowerCase()}`))
  .map((l) => l.slice(0, l.lastIndexOf('|'))))];
const allEmails = (cfg) => bare(cfg.stagingMirror, ['log', '--branches', '--format=%ae%n%ce']).split('\n').map((s) => s.trim());

function setup(commits, mailmapText, extra = {}) {
  const WS = mkdtempSync(join(tmpdir(), 'vector-id-'));
  const WORK = join(WS, 'work'); const AZ = join(WS, 'azure.git'); const GH = join(WS, 'github.git');
  mkdirSync(WORK); sh(['-C', WORK, 'init', '-q']);
  for (const c of commits) commit(WORK, c.name, c.email, c.date, c.msg);
  sh(['-C', WORK, 'branch', '-M', 'master']);
  sh(['clone', '-q', '--mirror', WORK, AZ]); sh(['init', '-q', '--bare', GH]);
  const cfg = finalizeConfig({ azureUrl: AZ, githubSsh: GH, project: 'p', mailmapText, ...extra }, { cwd: WS });
  return { WS, AZ, GH, cfg };
}

// (3) + (1) unify three source NAMES (same email) into one canonical, safety check passes
test('unify: three names / one email → one canonical, no safety-check false-fail',
  { skip: hasTools ? false : 'git / git-filter-repo not installed' }, async () => {
    const { WS, cfg } = setup([
      { name: 'YRACHEK101', email: 'yrachek@liadtech.com', date: '2020-01-01T00:00:00', msg: 'c1' },
      { name: 'Y. Rachek', email: 'yrachek@liadtech.com', date: '2020-01-02T00:00:00', msg: 'c2' },
      { name: 'yRachek', email: 'yrachek@liadtech.com', date: '2020-01-03T00:00:00', msg: 'c3' },
    ], 'YRACHEK101 <yrachek@liadtech.com>\n');
    try {
      const r = await migrate(cfg);                       // must NOT throw on the name-only safety check
      assert.equal(r.rewrite.rewritten, true);
      assert.deepEqual(stagingNames(cfg, 'yrachek@liadtech.com'), ['YRACHEK101'], 'all names unified');
      assert.ok(allEmails(cfg).includes('yrachek@liadtech.com'), 'the shared email is intentionally KEPT');
    } finally { rmSync(WS, { recursive: true, force: true }); }
  });

// (2) email change is still verified (old email must be gone)
test('email change: old email is purged and verified',
  { skip: hasTools ? false : 'git / git-filter-repo not installed' }, async () => {
    const { WS, cfg } = setup([
      { name: 'Old Me', email: 'old@corp.example', date: '2020-01-01T00:00:00', msg: 'c1' },
    ], 'octocat <me@personal.example> <old@corp.example>\n');
    try {
      const r = await migrate(cfg);
      assert.equal(r.rewrite.rewritten, true);
      assert.ok(!allEmails(cfg).includes('old@corp.example'), 'old email gone');
      assert.ok(allEmails(cfg).includes('me@personal.example'), 'new email present');
    } finally { rmSync(WS, { recursive: true, force: true }); }
  });

// (4) + (5) incremental re-run: already-present branch is skipped; deterministic (no-op)
test('incremental: identical re-run skips the branch and is deterministic',
  { skip: hasTools ? false : 'git / git-filter-repo not installed' }, async () => {
    const { WS, cfg } = setup([
      { name: 'Dev', email: 'dev@corp.com', date: '2020-01-01T00:00:00', msg: 'c1' },
    ], 'Canon <dev@corp.com>\n');
    try {
      const r1 = await migrate(cfg);
      assert.equal(r1.pushes[0].strategy, 'create');
      const sha1 = ghSha(cfg.GH || cfg.githubSsh);
      const staged1 = bare(cfg.stagingMirror, ['rev-parse', 'refs/heads/master']);

      const r2 = await migrate(cfg);                       // same inputs again
      assert.equal(r2.pushes[0].strategy, 'noop', 'already present + identical → skipped');
      assert.equal(ghSha(cfg.githubSsh), sha1, 'destination unchanged');
      assert.equal(bare(cfg.stagingMirror, ['rev-parse', 'refs/heads/master']), staged1, 'deterministic SHA');
    } finally { rmSync(WS, { recursive: true, force: true }); }
  });

// (6) present-but-different: skipped by default; force-updated only with --force-existing
test('force-existing: a differing existing branch is skipped by default, force-updated on opt-in',
  { skip: hasTools ? false : 'git / git-filter-repo not installed' }, async () => {
    // Run 1 puts identity "Alpha" on the destination.
    const { WS, AZ, GH } = setup([
      { name: 'Dev', email: 'dev@corp.com', date: '2020-01-01T00:00:00', msg: 'c1' },
    ], 'Alpha <dev@corp.com>\n');
    try {
      const cfg1 = finalizeConfig({ azureUrl: AZ, githubSsh: GH, project: 'p', mailmapText: 'Alpha <dev@corp.com>\n' }, { cwd: WS });
      await migrate(cfg1);
      const shaAlpha = ghSha(GH);

      // Run 2 maps the SAME source to a DIFFERENT name → diverges from what's on the destination.
      const cfg2 = finalizeConfig({ azureUrl: AZ, githubSsh: GH, project: 'p', mailmapText: 'Beta <dev@corp.com>\n' }, { cwd: WS });
      const rSkip = await migrate(cfg2);
      assert.equal(rSkip.pushes[0].strategy, 'diverged');
      assert.equal(rSkip.pushes[0].forced, false, 'not forced by default');
      assert.equal(ghSha(GH), shaAlpha, 'destination left intact without --force-existing');

      // Now opt in: force-update.
      const cfg3 = finalizeConfig({ azureUrl: AZ, githubSsh: GH, project: 'p', mailmapText: 'Beta <dev@corp.com>\n', forceExisting: true }, { cwd: WS });
      const rForce = await migrate(cfg3);
      assert.equal(rForce.pushes[0].forced, true, 'force-updated with --force-existing');
      assert.notEqual(ghSha(GH), shaAlpha, 'destination updated to the new identity');
      assert.deepEqual(stagingNames(cfg3, 'dev@corp.com'), ['Beta']);
    } finally { rmSync(WS, { recursive: true, force: true }); }
  });
