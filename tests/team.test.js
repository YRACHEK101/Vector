import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMailmap, parseMailmapLine, parseInlineMap, parseInlineMaps,
  resolveMailmapEntries, entriesToMailmap, summarizeEntries,
  parseIdentities, parseBranchRefs, resolveBranchSet,
  validateTeamConfig, validateModeFlags, summarizeMapping,
} from '../src/team.js';
import { configFromEnv, finalizeConfig, validateConfig, parseBool, parseMapsEnv } from '../src/config.js';
import { decidePushStrategy } from '../src/pipeline.js';

// ── 4a.1 — Mailmap parsing ──────────────────────────────────────────────────
test('parseMailmap: single & multi-developer files parse to expected mappings', () => {
  const text = `
# team mailmap
Alice New <alice@newco.com> <alice@oldcorp.com>

Bob New <bob@newco.com> Bob Old <bob@oldcorp.com>
Carol <carol@newco.com>
`;
  const entries = parseMailmap(text);
  assert.equal(entries.length, 3, 'comments and blank lines are ignored');
  assert.deepEqual(entries[0], { name: 'Alice New', email: 'alice@newco.com', sourceName: undefined, sourceEmail: 'alice@oldcorp.com' });
  assert.deepEqual(entries[1], { name: 'Bob New', email: 'bob@newco.com', sourceName: 'Bob Old', sourceEmail: 'bob@oldcorp.com' });
  // name-only form: source email == target email
  assert.deepEqual(entries[2], { name: 'Carol', email: 'carol@newco.com', sourceName: undefined, sourceEmail: 'carol@newco.com' });
});

test('parseMailmap: a malformed line throws an error naming the line number', () => {
  const text = 'Good Name <good@new.com> <good@old.com>\nthis line has no angle-bracket email\n';
  assert.throws(() => parseMailmap(text), (e) => {
    assert.match(e.message, /Malformed mailmap line 2/);
    return true;
  });
  // a target without a name is also rejected
  assert.throws(() => parseMailmapLine('<only@email.com>', 7), (e) => {
    assert.match(e.message, /line 7/);
    assert.match(e.message, /must include a name/);
    return true;
  });
});

// ── 4a.2 — Inline --map parsing ─────────────────────────────────────────────
test('parseInlineMap: a well-formed entry parses correctly', () => {
  assert.deepEqual(
    parseInlineMap('old@corp.com=New Name <new@personal.com>'),
    { name: 'New Name', email: 'new@personal.com', sourceName: undefined, sourceEmail: 'old@corp.com' },
  );
});

test('parseInlineMaps: repeated flags accumulate', () => {
  const entries = parseInlineMaps([
    'a@old.com=Ada <a@new.com>',
    'b@old.com=Ben <b@new.com>',
  ]);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.email), ['a@new.com', 'b@new.com']);
});

test('parseInlineMap: missing "=" or a bad target throws a clear error', () => {
  assert.throws(() => parseInlineMap('no-equals-here'), /missing "="/);
  assert.throws(() => parseInlineMap('old@corp.com=No Angle Brackets'), /target must be/);
  assert.throws(() => parseInlineMap('not-an-email=New <new@x.com>'), /not a valid old email/);
  assert.throws(() => parseInlineMap('old@corp.com=Name <bad-email>'), /not a valid email/);
});

// ── 4a.3 — Mailmap source precedence (file > inline > interactive) ───────────
test('resolveMailmapEntries: file overrides inline overrides interactive for the same source', () => {
  const fileText = 'File Name <file@new.com> <shared@old.com>\n';
  const mapStrings = ['shared@old.com=Inline Name <inline@new.com>'];
  const interactiveEntries = [{ name: 'Interactive Name', email: 'inter@new.com', sourceEmail: 'shared@old.com' }];
  const r = resolveMailmapEntries({ fileText, mapStrings, interactiveEntries });
  assert.equal(r.count, 1, 'the same source collapses to one mapping');
  assert.equal(r.entries[0].name, 'File Name');
  assert.equal(r.entries[0].email, 'file@new.com');
});

test('resolveMailmapEntries: distinct sources from different layers all survive', () => {
  const r = resolveMailmapEntries({
    fileText: 'A New <a@new.com> <a@old.com>\n',
    mapStrings: ['b@old.com=B New <b@new.com>'],
    interactiveEntries: [{ name: 'C New', email: 'c@new.com', sourceEmail: 'c@old.com' }],
  });
  assert.equal(r.count, 3);
  assert.deepEqual(r.rewriteEmails.map((e) => e.toLowerCase()).sort(), ['a@old.com', 'b@old.com', 'c@old.com']);
});

test('entriesToMailmap round-trips through parseMailmap', () => {
  const entries = parseMailmap('Alice <a@new.com> <a@old.com>\nBob <b@new.com> B Old <b@old.com>\n');
  assert.deepEqual(parseMailmap(entriesToMailmap(entries)), entries);
});

// ── 4a.4 — Team-mode config validation ──────────────────────────────────────
test('validateTeamConfig: zero mappings fails clearly', () => {
  const v = validateTeamConfig({ azureUrl: 'https://a', githubSsh: 'git@github.com:o/r.git', mappingCount: 0 });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /at least one identity mapping/.test(e)));
});

test('validateTeamConfig: a missing --mailmap file fails clearly', () => {
  const v = validateTeamConfig({ azureUrl: 'https://a', githubSsh: 'git@github.com:o/r.git', mappingCount: 1, mailmapPath: '/no/such/file', mailmapMissing: true });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /Mailmap file not found: \/no\/such\/file/.test(e)));
});

test('validateTeamConfig: passes with a valid SSH target and ≥1 mapping', () => {
  assert.equal(validateTeamConfig({ azureUrl: 'https://a', githubSsh: 'git@github.com:o/r.git', mappingCount: 2 }).ok, true);
});

test('validateModeFlags: --map/--mailmap without --team is rejected; with --team is ok', () => {
  assert.equal(validateModeFlags({ team: false, mapCount: 1 }).ok, false);
  assert.equal(validateModeFlags({ team: false, mailmapPath: '/x' }).ok, false);
  assert.equal(validateModeFlags({ team: true, mapCount: 1 }).ok, true);
  assert.equal(validateModeFlags({ team: false, mapCount: 0, mailmapPath: '' }).ok, true);
});

test('regression: personal mode with no new flags validates and finalizes as before', () => {
  const env = configFromEnv({
    AZURE_URL: 'https://a', GITHUB_SSH: 'git@github.com:u/r.git',
    OLD_EMAIL: 'old@corp.com', NEW_NAME: 'octo', NEW_EMAIL: 'me@personal.com',
  });
  assert.equal(env.teamMode, false);
  assert.equal(env.allBranches, false);
  const final = finalizeConfig(env);
  assert.equal(validateConfig(final).ok, true);
  assert.equal(final.mailmapText, 'octo <me@personal.com> <old@corp.com>\n');
  assert.deepEqual(final.rewriteEmails, ['old@corp.com']);
  assert.equal(final.hasNameOnlyMapping, false);
});

test('finalizeConfig (team): a supplied mailmap drives rewriteEmails, not new*/oldEmail', () => {
  const final = finalizeConfig({
    githubSsh: 'git@github.com:o/r.git', azureUrl: 'https://a', teamMode: true,
    mailmapText: 'Alice <a@new.com> <a@old.com>\nBob <b@new.com> <b@old.com>\n',
  });
  assert.deepEqual(final.rewriteEmails.map((e) => e.toLowerCase()).sort(), ['a@old.com', 'b@old.com']);
  assert.equal(final.teamMode, true);
});

test('env helpers: parseBool and parseMapsEnv', () => {
  assert.equal(parseBool('1'), true);
  assert.equal(parseBool('TRUE'), true);
  assert.equal(parseBool('0'), false);
  assert.equal(parseBool(''), false);
  assert.equal(parseBool(undefined), false);
  assert.deepEqual(parseMapsEnv('a@x=A <a@n>\nb@x=B <b@n>'), ['a@x=A <a@n>', 'b@x=B <b@n>']);
  assert.deepEqual(parseMapsEnv('a@x=A <a@n>,b@x=B <b@n>'), ['a@x=A <a@n>', 'b@x=B <b@n>']);
});

// ── 4a.5 — Author detection ─────────────────────────────────────────────────
test('parseIdentities: returns the unique, sorted identity list', () => {
  const raw = [
    'Alice|alice@oldcorp.com',
    'alice|ALICE@oldcorp.com',     // case variant → collapses
    'Bob|bob@oldcorp.com',
    'Bob|bob@oldcorp.com',         // exact duplicate → collapses
    'Carol|carol@external.com',
    'Dave|dave@oldcorp.com',       // committer-only identity is still detected
    '',                            // blank line ignored
  ].join('\n');
  const ids = parseIdentities(raw);
  assert.deepEqual(ids, [
    { name: 'Alice', email: 'alice@oldcorp.com' },
    { name: 'Bob', email: 'bob@oldcorp.com' },
    { name: 'Carol', email: 'carol@external.com' },
    { name: 'Dave', email: 'dave@oldcorp.com' },
  ]);
});

test('summarizeMapping: counts mapped vs unchanged authors', () => {
  const ids = parseIdentities('Alice|a@old.com\nBob|b@old.com\nCarol|c@ext.com');
  const { entries } = resolveMailmapEntries({ mapStrings: ['a@old.com=A <a@new.com>', 'b@old.com=B <b@new.com>'] });
  assert.deepEqual(summarizeMapping(ids, entries), { authors: 3, mapped: 2, unchanged: 1 });
});

// ── 4a.6 — Branch resolution ────────────────────────────────────────────────
test('resolveBranchSet: --all-branches yields every branch (sorted, deduped)', () => {
  const available = parseBranchRefs('main\ndevelop\nfeature/x\n');
  assert.deepEqual(resolveBranchSet({ allBranches: true, available }), ['develop', 'feature/x', 'main']);
});

test('resolveBranchSet: explicit branches are honored and order-preserved', () => {
  assert.deepEqual(resolveBranchSet({ allBranches: false, explicit: ['main', 'develop', 'main'] }), ['main', 'develop']);
});

test('resolveBranchSet: --all-branches overrides explicit selection', () => {
  assert.deepEqual(
    resolveBranchSet({ allBranches: true, available: ['main', 'develop'], explicit: ['main'] }),
    ['develop', 'main'],
  );
});

// ── 4a.7 — Push decision holds per-branch across many branches ───────────────
test('decidePushStrategy: correct decision per branch across a multi-branch set', () => {
  const chain = (a, b) => (x, y) => x === a && y === b;
  const cases = [
    { branch: 'new', localSha: 'L', remoteSha: '', isAncestor: () => false, want: 'create' },
    { branch: 'same', localSha: 'S', remoteSha: 'S', isAncestor: () => false, want: 'noop' },
    { branch: 'ff', localSha: 'B', remoteSha: 'A', isAncestor: chain('A', 'B'), want: 'fast-forward' },
    { branch: 'behind', localSha: 'A', remoteSha: 'B', isAncestor: chain('A', 'B'), want: 'remote-ahead' },
    { branch: 'forked', localSha: 'X', remoteSha: 'Y', isAncestor: () => false, want: 'diverged' },
    { branch: 'gone', localSha: '', remoteSha: 'Z', isAncestor: () => false, want: 'missing-local' },
  ];
  for (const c of cases) {
    assert.equal(decidePushStrategy(c), c.want, `branch ${c.branch} → ${c.want}`);
  }
});
