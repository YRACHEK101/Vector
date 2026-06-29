// Unit tests for the interactive mapping wizard's auto-match + "None of these /
// skip" escape, driven by an injected fake inquirer (no TTY, no real prompts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMappingWizard, SKIP_IDENTITY_VALUE, SKIP_IDENTITY_LABEL } from '../src/wizard.js';

const IDS = [
  { name: 'Alice', email: 'alice@a.com' },
  { name: 'Bob', email: 'bob@corp.com' },
];

/** A fake inquirer that returns scripted answers in order and records the questions asked. */
function fakeInquirer(responses) {
  let i = 0;
  const asked = [];
  const inq = {
    Separator: function Separator() { this.type = 'separator'; },
    prompt: async (questions) => {
      asked.push(questions);
      if (i >= responses.length) throw new Error('unexpected extra prompt');
      return responses[i++];
    },
  };
  return { inq, asked };
}

test('auto-matches via the entered email — never asks "which author is you?"', async () => {
  const { inq, asked } = fakeInquirer([{ newName: 'Bobby', newEmail: 'bob@corp.com' }]);
  const out = await runMappingWizard([IDS[1]], { gitName: '', gitEmail: '', inquirer: inq });
  assert.equal(out.skipped, false);
  assert.equal(out.entries.length, 1);
  assert.equal(out.entries[0].sourceEmail, 'bob@corp.com');
  assert.equal(out.entries[0].name, 'Bobby');
  assert.equal(asked.length, 1, 'only the new-identity prompt — no "which is you?" prompt');
});

test('no match → the prompt offers an explicit skip option; choosing it skips', async () => {
  const { inq, asked } = fakeInquirer([
    { newName: 'Outsider', newEmail: 'outsider@nope.com' }, // matches no detected author
    { youEmail: SKIP_IDENTITY_VALUE },                      // pick "None of these"
  ]);
  const out = await runMappingWizard(IDS, { gitName: '', gitEmail: '', inquirer: inq });
  assert.equal(out.skipped, true);
  assert.deepEqual(out.entries, []);
  // The "which is you?" prompt must include the skip choice with the exact label.
  const youPrompt = asked[1][0];
  const skip = youPrompt.choices.find((ch) => ch && ch.value === SKIP_IDENTITY_VALUE);
  assert.ok(skip, 'skip choice present');
  assert.equal(skip.name, SKIP_IDENTITY_LABEL);
});

test('no match → selecting a real author still works (and keeps others)', async () => {
  const { inq } = fakeInquirer([
    { newName: 'NewAlice', newEmail: 'newalice@gh.com' },
    { youEmail: 'alice@a.com' }, // I am Alice
    { editTeam: false },         // don't remap Bob
  ]);
  const out = await runMappingWizard(IDS, { gitName: '', gitEmail: '', inquirer: inq });
  assert.equal(out.skipped, false);
  assert.equal(out.entries.length, 1);
  assert.equal(out.entries[0].sourceEmail, 'alice@a.com');
  assert.equal(out.entries[0].email, 'newalice@gh.com');
});

test('--me matches by name → auto-selected without prompting', async () => {
  const { inq, asked } = fakeInquirer([{ newName: 'X', newEmail: 'x@y.com' }]);
  const out = await runMappingWizard([{ name: 'Octocat', email: 'o@c.com' }], { gitName: '', gitEmail: '', me: 'Octocat', inquirer: inq });
  assert.equal(out.skipped, false);
  assert.equal(out.entries[0].sourceEmail, 'o@c.com');
  assert.equal(asked.length, 1, 'no "which is you?" prompt when --me resolves it');
});
