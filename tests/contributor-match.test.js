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

test('matchYou: falls back to name when no email matches', () => {
  assert.deepEqual(matchYou({ identities: IDS, names: ['MAHMOUD'] }), IDS[1]);
});

test('matchYou: email takes priority over name', () => {
  // name signal points at mahmoud, email signal points at Rachek → email wins.
  const got = matchYou({ identities: IDS, emails: ['yrachek@liadtech.com'], names: ['mahmoud'] });
  assert.deepEqual(got, IDS[2]);
});

test('matchYou: no signal matches → null (the "not a contributor" case)', () => {
  assert.equal(matchYou({ identities: IDS, emails: ['nobody@nowhere.com'], names: ['Ghost'] }), null);
  assert.equal(matchYou({ identities: IDS }), null);
  assert.equal(matchYou({ identities: [], emails: ['x@y.com'] }), null);
});

test('youSignals: routes --me to email vs name by shape, drops blanks', () => {
  const a = youSignals({ newEmail: 'me@gh.com', gitName: 'Me', me: 'who@team.com' });
  assert.deepEqual(a.emails.sort(), ['me@gh.com', 'who@team.com']);
  assert.deepEqual(a.names, ['Me']);
  const b = youSignals({ me: 'Octocat', githubUser: 'octo' });
  assert.deepEqual(b.emails, []);
  assert.deepEqual(b.names.sort(), ['Octocat', 'octo']);
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
