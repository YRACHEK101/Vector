// Unit tests for "which detected author is YOU?" matching and the non-interactive
// auto-match / auto-skip decision — all pure, offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchYou, youSignals, planIdentityMatch } from '../src/team.js';
import { configFromEnv, finalizeConfig, validateRun } from '../src/config.js';

const IDS = [
  { name: 'Laaouina18', email: 'laaouinanouhaila2019@gmail.com' },
  { name: 'mahmoud', email: 'mdraoui@liadtech.com' },
  { name: 'Y. Rachek', email: 'yrachek@liadtech.com' },
];

test('matchYou: email signal matches (case-insensitive)', () => {
  assert.deepEqual(matchYou({ identities: IDS, emails: ['YRACHEK@LIADTECH.COM'] }), IDS[2]);
});

// Authors from the real failure: the user's email is NOT among them, but a
// git/display name (mahmoud, y-rachek) coincides — the matcher must NOT match.
const NINE = [
  { name: 'Abdellah BOUSKRI', email: 'abouskri@liadtech.com' },
  { name: 'mahmoud', email: 'mdraoui@liadtech.com' },
  { name: 'Mahmoud DRAOUI', email: 'mdraoui@liadtech.com' },
  { name: 'Nouhaila LAAOUINA', email: 'nlaaouina@liadtech.com' },
];

test('matchYou: name matching is OFF by default — a name-only coincidence returns null', () => {
  // The exact real-world false positive: returns null so the skip path runs.
  assert.equal(matchYou({ identities: NINE, emails: ['yrachek@liadtech.com'], names: ['y-rachek', 'mahmoud'] }), null);
  assert.equal(matchYou({ identities: IDS, names: ['MAHMOUD'] }), null, 'a name signal alone never matches by default');
});

test('matchYou: matches on exact, case-insensitive EMAIL', () => {
  assert.deepEqual(matchYou({ identities: IDS, emails: ['MDRAOUI@LIADTECH.COM'] }), IDS[1]);
  assert.deepEqual(matchYou({ identities: IDS, emails: ['nope@x.com', 'yrachek@liadtech.com'] }), IDS[2]);
});

test('matchYou: never matches on a shared domain (full-address equality only)', () => {
  assert.equal(matchYou({ identities: [{ name: 'A', email: 'a@liadtech.com' }], emails: ['z@liadtech.com'] }), null);
});

test('matchYou: name matching happens only with the explicit opt-in (allowNameMatch)', () => {
  // Reserved for a deliberate `--me "Name"` self-identification.
  assert.equal(matchYou({ identities: IDS, names: ['mahmoud'] }), null, 'off by default');
  assert.deepEqual(matchYou({ identities: IDS, names: ['MAHMOUD'], allowNameMatch: true }), IDS[1], 'opt-in matches by name');
});

test('matchYou: no email match → null (not a contributor)', () => {
  assert.equal(matchYou({ identities: IDS, emails: ['nobody@nowhere.com'] }), null);
  assert.equal(matchYou({ identities: IDS }), null);
  assert.equal(matchYou({ identities: [], emails: ['x@y.com'] }), null);
});

test('youSignals: only trustworthy email signals; names holds an explicit --me name only', () => {
  const a = youSignals({ newEmail: 'me@gh.com', gitEmail: 'me@corp.com', me: 'who@team.com' });
  assert.deepEqual(a.emails.sort(), ['me@corp.com', 'me@gh.com', 'who@team.com']);
  assert.deepEqual(a.names, [], 'an --me address is an email signal, not a name signal');
  const b = youSignals({ me: 'Octocat' });
  assert.deepEqual(b.emails, []);
  assert.deepEqual(b.names, ['Octocat'], 'an explicit --me name is the only name signal');
  // Weak hints (gitName/githubUser/newName) are ignored even if passed (back-compat).
  const c = youSignals({ newEmail: 'x@y.com', gitName: 'Coincidence', githubUser: 'coincidence' });
  assert.deepEqual(c.names, [], 'git/GitHub names never become matching signals');
});

test('planIdentityMatch: matched via --me → builds rewrite entries (no skip)', () => {
  const plan = planIdentityMatch({
    identities: IDS, me: 'mdraoui@liadtech.com', newName: 'Mahmoud Draoui', newEmail: 'mahmoud@users.noreply.github.com',
  });
  assert.equal(plan.skip, false);
  assert.deepEqual(plan.matched, IDS[1]);
  assert.equal(plan.entries.length, 1);
  assert.equal(plan.entries[0].sourceEmail, 'mdraoui@liadtech.com');
  assert.equal(plan.entries[0].email, 'mahmoud@users.noreply.github.com');
});

test('planIdentityMatch: no author matches → skip, no entries', () => {
  const plan = planIdentityMatch({ identities: IDS, newName: 'Outsider', newEmail: 'outsider@nope.com' });
  assert.equal(plan.skip, true);
  assert.equal(plan.matched, null);
  assert.deepEqual(plan.entries, []);
});

test('planIdentityMatch: bad --me value → skip (never rewrite the wrong person)', () => {
  const plan = planIdentityMatch({ identities: IDS, me: 'ghost@nowhere.com', newName: 'X', newEmail: 'x@y.com' });
  assert.equal(plan.skip, true);
  assert.equal(plan.matched, null);
});

test('planIdentityMatch: matched but no usable new identity → skip', () => {
  const plan = planIdentityMatch({ identities: IDS, me: 'mdraoui@liadtech.com' }); // no new name/email
  assert.equal(plan.skip, true);
});

test('planIdentityMatch: non-contributor with a name coincidence still skips (the real bug)', () => {
  // gitName "mahmoud" and githubUser "y-rachek" coincide with authors, but the
  // user's email isn't among them → must skip, not falsely rewrite someone.
  const plan = planIdentityMatch({
    identities: NINE, newName: 'y-rachek', newEmail: 'yrachek@liadtech.com', gitName: 'mahmoud', githubUser: 'y-rachek',
  });
  assert.equal(plan.skip, true);
  assert.equal(plan.matched, null);
  assert.deepEqual(plan.entries, []);
});

test('planIdentityMatch: a genuine email match (via git config) produces entries', () => {
  const plan = planIdentityMatch({ identities: IDS, newName: 'Mahmoud', newEmail: 'mahmoud@users.noreply.github.com', gitEmail: 'MDRAOUI@liadtech.com' });
  assert.equal(plan.skip, false);
  assert.deepEqual(plan.matched, IDS[1]);
  assert.ok(plan.entries.length >= 1);
  assert.equal(plan.entries[0].sourceEmail, 'mdraoui@liadtech.com');
});

test('config: --skip-identity / --me plumb through env and finalize', () => {
  const env = configFromEnv({ SKIP_IDENTITY: '1', ME: 'me@x.com' });
  assert.equal(env.skipIdentity, true);
  assert.equal(env.me, 'me@x.com');
  const f = finalizeConfig({ skipIdentity: true, me: '  who@team.com ' });
  assert.equal(f.skipIdentity, true);
  assert.equal(f.me, 'who@team.com');
  assert.equal(finalizeConfig({}).skipIdentity, false);
});

test('config: validateRun does not require a mapping when identity is skipped', () => {
  const base = { mode: 'a', source: 'git@ssh.dev.azure.com:v3/o/p/r', dest: 'git@github.com:me/repo.git' };
  const withoutSkip = finalizeConfig(base);
  assert.equal(validateRun(withoutSkip, { interactive: false }).ok, false, 'rewrite + no mapping normally errors');
  const withSkip = finalizeConfig({ ...base, skipIdentity: true });
  assert.equal(validateRun(withSkip, { interactive: false }).ok, true, '--skip-identity makes it a valid mirror run');
});
