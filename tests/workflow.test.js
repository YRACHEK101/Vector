import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMailmap, parseMailmapLine, parseInlineMap, parseInlineMaps,
  entriesToMailmap, buildIdentityEntries, buildLegacyEntries,
  parseIdentities, resolveYou, defaultNewIdentity,
  parseBranchRefs, resolveBranches, summarizeMapping,
} from '../src/team.js';
import { finalizeConfig, validateRun } from '../src/config.js';
import { decidePushStrategy } from '../src/pipeline.js';

// ── 3a.1 — Author detection parsing ─────────────────────────────────────────
test('parseIdentities: unique, sorted identities (dupes, case, committer≠author rows)', () => {
  const raw = [
    'Alice|alice@oldcorp.com',
    'alice|ALICE@oldcorp.com',   // case variant → collapses
    'Bob|bob@oldcorp.com',
    'Bob|bob@oldcorp.com',       // exact dup → collapses
    'Carol|carol@external.com',
    'Dave|dave@oldcorp.com',     // committer-only identity still detected
    '',
  ].join('\n');
  assert.deepEqual(parseIdentities(raw), [
    { name: 'Alice', email: 'alice@oldcorp.com' },
    { name: 'Bob', email: 'bob@oldcorp.com' },
    { name: 'Carol', email: 'carol@external.com' },
    { name: 'Dave', email: 'dave@oldcorp.com' },
  ]);
});

// ── 3a.2 — "You" resolution ─────────────────────────────────────────────────
test('resolveYou: matches the git-config email (case-insensitive), else null', () => {
  const ids = [{ name: 'Alice', email: 'alice@oldcorp.com' }, { name: 'Bob', email: 'bob@oldcorp.com' }];
  assert.deepEqual(resolveYou({ identities: ids, gitEmail: 'BOB@oldcorp.com' }), { name: 'Bob', email: 'bob@oldcorp.com' });
  assert.equal(resolveYou({ identities: ids, gitEmail: 'nobody@x.com' }), null);
  assert.equal(resolveYou({ identities: ids, gitEmail: '' }), null);
});

// ── 3a.3 — Default new-identity resolution ──────────────────────────────────
test('defaultNewIdentity: from git config, graceful on missing values', () => {
  assert.deepEqual(defaultNewIdentity({ gitName: 'Octo', gitEmail: 'me@personal.com' }), { name: 'Octo', email: 'me@personal.com' });
  assert.equal(defaultNewIdentity({ gitName: '', gitEmail: '' }), null);
  assert.deepEqual(defaultNewIdentity({ gitName: 'Octo', gitEmail: '' }), { name: 'Octo', email: '' });
  assert.deepEqual(defaultNewIdentity({ gitEmail: 'me@personal.com' }), { name: '', email: 'me@personal.com' });
});

// ── 3a.4 — Mailmap builder (you→new, rest kept; add teammate; skip) ──────────
test('buildIdentityEntries: default maps only you; teammates add; skip keeps', () => {
  const you = { name: 'Alice Old', email: 'alice@oldcorp.com' };
  const newIdentity = { name: 'Alice New', email: 'alice@newco.com' };

  const dflt = buildIdentityEntries({ you, newIdentity });
  assert.equal(entriesToMailmap(dflt), 'Alice New <alice@newco.com> <alice@oldcorp.com>\n');

  const withMate = buildIdentityEntries({
    you, newIdentity,
    teammates: [{ sourceEmail: 'bob@oldcorp.com', target: { name: 'Bob New', email: 'bob@newco.com' } }],
  });
  assert.equal(entriesToMailmap(withMate),
    'Alice New <alice@newco.com> <alice@oldcorp.com>\nBob New <bob@newco.com> <bob@oldcorp.com>\n');

  const skipped = buildIdentityEntries({ you, newIdentity, teammates: [{ sourceEmail: 'carol@external.com', target: null }] });
  assert.equal(skipped.length, 1, 'a skipped teammate produces no entry (kept unchanged)');
});

// ── 3a.5 — Mailmap file + inline --map parsing ──────────────────────────────
test('parseMailmap: single & multi entries; comments/blanks ignored; line-numbered errors', () => {
  const entries = parseMailmap('# header\n\nA <a@new.com> <a@old.com>\nB <b@new.com> B Old <b@old.com>\n');
  assert.equal(entries.length, 2);
  assert.equal(entries[1].sourceName, 'B Old');
  assert.throws(() => parseMailmap('ok <a@new.com> <a@old.com>\ngarbage line\n'), /Malformed mailmap line 2/);
  assert.throws(() => parseMailmapLine('<no@name.com>', 4), /line 4/);
});

test('parseInlineMap: valid parses; missing "=" or bad target throws clearly; repeats accumulate', () => {
  assert.deepEqual(parseInlineMap('old@corp.com=New Name <new@personal.com>'),
    { name: 'New Name', email: 'new@personal.com', sourceName: undefined, sourceEmail: 'old@corp.com' });
  assert.throws(() => parseInlineMap('no-equals'), /missing "="/);
  assert.throws(() => parseInlineMap('old@corp.com=No Brackets'), /target must be/);
  assert.equal(parseInlineMaps(['a@o=A <a@n.com>', 'b@o=B <b@n.com>']).length, 2);
});

// ── 3a.6 — Branch resolution ────────────────────────────────────────────────
test('resolveBranches: default is ALL; --branch narrows; --all-branches & combos', () => {
  const available = parseBranchRefs('main\ndevelop\nfeature/x\n');
  assert.deepEqual(resolveBranches({ available }), ['develop', 'feature/x', 'main'], 'default = all (sorted)');
  assert.deepEqual(resolveBranches({ explicit: ['develop'], available }), ['develop'], '--branch narrows');
  assert.deepEqual(resolveBranches({ allBranches: true, explicit: ['develop'], available }), ['develop', 'feature/x', 'main'], '--all-branches overrides narrowing');
  assert.deepEqual(resolveBranches({ explicit: ['main', 'main'], available }), ['main'], 'explicit deduped');
});

// ── 3a.7 — Config validation (interactive vs non-interactive; legacy regression) ──
test('validateRun: non-interactive needs a complete mapping; interactive does not', () => {
  const base = finalizeConfig({ azureUrl: 'https://a', githubSsh: 'git@github.com:o/r.git' });
  assert.equal(validateRun(base, { interactive: false }).ok, false, 'no mapping → fails in non-interactive');
  assert.ok(validateRun(base, { interactive: false }).errors.some((e) => /complete identity mapping/.test(e)));
  assert.equal(validateRun(base, { interactive: true }).ok, true, 'interactive can build the mapping later');
});

test('validateRun: legacy --old-email/--new-* trio still validates (regression)', () => {
  const final = finalizeConfig({
    azureUrl: 'https://a', githubSsh: 'git@github.com:o/r.git',
    oldEmail: 'old@corp.com', newName: 'octo', newEmail: 'me@personal.com',
  });
  assert.equal(final.mailmapText, 'octo <me@personal.com> <old@corp.com>\n');
  assert.deepEqual(final.rewriteEmails, ['old@corp.com']);
  assert.equal(validateRun(final, { interactive: false }).ok, true);
});

test('validateRun: missing source/destination and bad SSH form are flagged', () => {
  assert.equal(validateRun(finalizeConfig({ githubSsh: 'git@github.com:o/r.git', oldEmail: 'o@c.com', newName: 'n', newEmail: 'n@x.com' }), { interactive: true }).ok, false);
  const badSsh = validateRun(finalizeConfig({ azureUrl: 'https://a', githubSsh: 'https://github.com/o/r' }), { interactive: true });
  assert.equal(badSsh.ok, false);
  assert.ok(badSsh.errors.some((e) => /SSH URL/.test(e)));
});

test('buildLegacyEntries: empty unless name+email present; maps each old email', () => {
  assert.deepEqual(buildLegacyEntries({ oldEmail: 'o@c.com', newName: 'n', newEmail: 'n@x.com' }),
    [{ name: 'n', email: 'n@x.com', sourceName: undefined, sourceEmail: 'o@c.com' }]);
  assert.deepEqual(buildLegacyEntries({ oldEmail: 'o@c.com', newEmail: 'n@x.com' }), [], 'no newName → no entries');
});

test('summarizeMapping: authors mapped vs kept', () => {
  const ids = parseIdentities('A|a@o.com\nB|b@o.com\nC|c@e.com');
  const entries = parseMailmap('A New <a@n.com> <a@o.com>\n');
  assert.deepEqual(summarizeMapping(ids, entries), { authors: 3, mapped: 1, unchanged: 2 });
});

// ── 3a.8 — Push decision holds per branch across many branches (regression) ──
test('decidePushStrategy: correct per-branch decision across a multi-branch set', () => {
  const chain = (a, b) => (x, y) => x === a && y === b;
  const cases = [
    { branch: 'new', localSha: 'L', remoteSha: '', isAncestor: () => false, want: 'create' },
    { branch: 'same', localSha: 'S', remoteSha: 'S', isAncestor: () => false, want: 'noop' },
    { branch: 'ff', localSha: 'B', remoteSha: 'A', isAncestor: chain('A', 'B'), want: 'fast-forward' },
    { branch: 'behind', localSha: 'A', remoteSha: 'B', isAncestor: chain('A', 'B'), want: 'remote-ahead' },
    { branch: 'forked', localSha: 'X', remoteSha: 'Y', isAncestor: () => false, want: 'diverged' },
    { branch: 'gone', localSha: '', remoteSha: 'Z', isAncestor: () => false, want: 'missing-local' },
  ];
  for (const c of cases) assert.equal(decidePushStrategy(c), c.want, `branch ${c.branch}`);
});
