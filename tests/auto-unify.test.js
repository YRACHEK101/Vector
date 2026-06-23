// Auto-unify: providing NAME + EMAIL unifies EVERY name under my email(s) — the
// source email AND my new email (when it already carries a different name) — while
// other people's identities stay untouched. Pure tests always run; the end-to-end
// tests exercise buildIdentityEntries → mailmap → filter-repo and are gated on tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIdentityEntries, myUnifyEmails, entriesToMailmap } from '../src/team.js';
import { finalizeConfig } from '../src/config.js';
import { migrate, validateMappings } from '../src/pipeline.js';

// ── Pure: which of my emails get unified ─────────────────────────────────────
test('myUnifyEmails: source email always; new email too when it already has another name', () => {
  const ids = [
    { name: 'Y. Rachek', email: 'yrachek@liadtech.com' },
    { name: 'Yahia RACHEK', email: 'yrachek@liadtech.com' },
    { name: 'old', email: 'r.yahia.dev@gmail.com' },     // my new email, different name
    { name: 'Mate', email: 'mate@x.com' },
  ];
  const you = { name: 'Y. Rachek', email: 'yrachek@liadtech.com' };
  // new email differs in history → both emails unify
  assert.deepEqual(
    myUnifyEmails({ you, newIdentity: { name: 'YRACHEK101', email: 'r.yahia.dev@gmail.com' }, identities: ids }).map((e) => e.toLowerCase()).sort(),
    ['r.yahia.dev@gmail.com', 'yrachek@liadtech.com']);
  // new email NOT in history → only the source email
  assert.deepEqual(
    myUnifyEmails({ you, newIdentity: { name: 'YRACHEK101', email: 'fresh@gmail.com' }, identities: ids }),
    ['yrachek@liadtech.com']);
  // back-compat: no identities → just the source email
  assert.deepEqual(
    myUnifyEmails({ you, newIdentity: { name: 'X', email: 'x@y.com' } }), ['yrachek@liadtech.com']);
});

// ── Pure: buildIdentityEntries auto-unifies + keeps the detected identity ─────
test('buildIdentityEntries: detected-you name (differs) is unified, not skipped', () => {
  const ids = [{ name: 'Y. Rachek', email: 'e@co.com' }, { name: 'Yahia RACHEK', email: 'e@co.com' }];
  const entries = buildIdentityEntries({ you: { name: 'Y. Rachek', email: 'e@co.com' }, newIdentity: { name: 'y-rachek', email: 'e@co.com' }, identities: ids });
  // name-only entry keyed on the email unifies BOTH names (incl. the detected one)
  assert.equal(entriesToMailmap(entries), 'y-rachek <e@co.com>\n');
});

test('buildIdentityEntries: also normalizes my NEW email when it carries another name', () => {
  const ids = [
    { name: 'Y. Rachek', email: 'liad@co.com' },
    { name: 'old', email: 'me@gh.com' }, // new email, different name
  ];
  const entries = buildIdentityEntries({ you: { name: 'Y. Rachek', email: 'liad@co.com' }, newIdentity: { name: 'YRACHEK101', email: 'me@gh.com' }, identities: ids });
  const mm = entriesToMailmap(entries);
  assert.match(mm, /YRACHEK101 <me@gh\.com> <liad@co\.com>/); // liad → canonical
  assert.match(mm, /^YRACHEK101 <me@gh\.com>$/m);            // me@gh.com name normalized too
});

test('validateMappings passes once everything is unified to the canonical', () => {
  const entries = buildIdentityEntries({
    you: { name: 'Y. Rachek', email: 'liad@co.com' },
    newIdentity: { name: 'YRACHEK101', email: 'me@gh.com' },
    identities: [{ name: 'Y. Rachek', email: 'liad@co.com' }, { name: 'old', email: 'me@gh.com' }],
  });
  // post-rewrite history: everything is YRACHEK101 <me@gh.com>
  assert.deepEqual(validateMappings([{ name: 'YRACHEK101', email: 'me@gh.com' }], entries), []);
});

// ── Integration harness ──────────────────────────────────────────────────────
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
const pairs = (cfg) => [...new Set(bare(cfg.stagingMirror, ['log', '--branches', '--format=%aN|%aE']).split('\n').map((s) => s.trim()).filter(Boolean))];

function setup(commits, mailmapText) {
  const WS = mkdtempSync(join(tmpdir(), 'vector-unify-'));
  const WORK = join(WS, 'work'); const AZ = join(WS, 'azure.git'); const GH = join(WS, 'github.git');
  mkdirSync(WORK); sh(['-C', WORK, 'init', '-q']);
  for (const c of commits) commit(WORK, c.name, c.email, c.date, c.msg);
  sh(['-C', WORK, 'branch', '-M', 'master']);
  sh(['clone', '-q', '--mirror', WORK, AZ]); sh(['init', '-q', '--bare', GH]);
  return { WS, cfg: finalizeConfig({ azureUrl: AZ, githubSsh: GH, project: 'p', mailmapText }, { cwd: WS }) };
}

// (1)+(2) three names on one email (incl. the detected one) → all unified; safety passes
test('e2e: three names / one email all unify to the chosen name; safety passes',
  { skip: hasTools ? false : 'tools missing' }, async () => {
    const ids = [
      { name: 'Y. Rachek', email: 'yrachek@liadtech.com' },
      { name: 'Yahia RACHEK', email: 'yrachek@liadtech.com' },
      { name: 'yRachek', email: 'yrachek@liadtech.com' },
    ];
    const mm = entriesToMailmap(buildIdentityEntries({ you: ids[0], newIdentity: { name: 'y-rachek', email: 'yrachek@liadtech.com' }, identities: ids }));
    const { WS, cfg } = setup([
      { name: 'Y. Rachek', email: 'yrachek@liadtech.com', date: '2020-01-01T00:00:00', msg: 'c1' },
      { name: 'Yahia RACHEK', email: 'yrachek@liadtech.com', date: '2020-01-02T00:00:00', msg: 'c2' },
      { name: 'yRachek', email: 'yrachek@liadtech.com', date: '2020-01-03T00:00:00', msg: 'c3' },
    ], mm);
    try {
      const r = await migrate(cfg);                                   // must not throw the safety check
      assert.equal(r.rewrite.rewritten, true);
      assert.deepEqual(pairs(cfg), ['y-rachek|yrachek@liadtech.com'], 'all three names unified');
    } finally { rmSync(WS, { recursive: true, force: true }); }
  });

// the real bug: my NEW email already carries another name → it gets unified too
test('e2e: a stray name on my NEW email is normalized during unification',
  { skip: hasTools ? false : 'tools missing' }, async () => {
    const ids = [
      { name: 'Y. Rachek', email: 'yrachek@liadtech.com' },
      { name: 'Yahia RACHEK', email: 'yrachek@liadtech.com' },
      { name: 'yRachek', email: 'r.yahia.dev@gmail.com' },           // new email, different name
    ];
    const mm = entriesToMailmap(buildIdentityEntries({ you: ids[0], newIdentity: { name: 'YRACHEK101', email: 'r.yahia.dev@gmail.com' }, identities: ids }));
    const { WS, cfg } = setup([
      { name: 'Y. Rachek', email: 'yrachek@liadtech.com', date: '2020-01-01T00:00:00', msg: 'c1' },
      { name: 'Yahia RACHEK', email: 'yrachek@liadtech.com', date: '2020-01-02T00:00:00', msg: 'c2' },
      { name: 'yRachek', email: 'r.yahia.dev@gmail.com', date: '2020-01-03T00:00:00', msg: 'c3' },
    ], mm);
    try {
      const r = await migrate(cfg);
      assert.equal(r.rewrite.rewritten, true);
      assert.deepEqual(pairs(cfg), ['YRACHEK101|r.yahia.dev@gmail.com'], 'every name across both my emails unified');
    } finally { rmSync(WS, { recursive: true, force: true }); }
  });

// (3)+(4) a teammate on another email is untouched by default; remapped only if asked
test('e2e: other people on other emails are untouched by default',
  { skip: hasTools ? false : 'tools missing' }, async () => {
    const ids = [
      { name: 'Y. Rachek', email: 'yrachek@liadtech.com' },
      { name: 'Mate', email: 'mate@team.com' },
    ];
    const mm = entriesToMailmap(buildIdentityEntries({ you: ids[0], newIdentity: { name: 'YRACHEK101', email: 'yrachek@liadtech.com' }, identities: ids }));
    const { WS, cfg } = setup([
      { name: 'Y. Rachek', email: 'yrachek@liadtech.com', date: '2020-01-01T00:00:00', msg: 'c1' },
      { name: 'Mate', email: 'mate@team.com', date: '2020-01-02T00:00:00', msg: 'c2' },
    ], mm);
    try {
      await migrate(cfg);
      const got = pairs(cfg).sort();
      assert.ok(got.includes('YRACHEK101|yrachek@liadtech.com'), 'I am unified');
      assert.ok(got.includes('Mate|mate@team.com'), 'teammate untouched');
    } finally { rmSync(WS, { recursive: true, force: true }); }
  });

// (5) re-run with the same inputs is a deterministic no-op
test('e2e: re-run after unification is a no-op (already present + identical)',
  { skip: hasTools ? false : 'tools missing' }, async () => {
    const ids = [{ name: 'Y. Rachek', email: 'yrachek@liadtech.com' }, { name: 'Yahia RACHEK', email: 'yrachek@liadtech.com' }];
    const mm = entriesToMailmap(buildIdentityEntries({ you: ids[0], newIdentity: { name: 'y-rachek', email: 'yrachek@liadtech.com' }, identities: ids }));
    const { WS, cfg } = setup([
      { name: 'Y. Rachek', email: 'yrachek@liadtech.com', date: '2020-01-01T00:00:00', msg: 'c1' },
      { name: 'Yahia RACHEK', email: 'yrachek@liadtech.com', date: '2020-01-02T00:00:00', msg: 'c2' },
    ], mm);
    try {
      const r1 = await migrate(cfg); assert.equal(r1.pushes[0].strategy, 'create');
      const r2 = await migrate(cfg); assert.equal(r2.pushes[0].strategy, 'noop', 'identical re-run is a no-op');
    } finally { rmSync(WS, { recursive: true, force: true }); }
  });
