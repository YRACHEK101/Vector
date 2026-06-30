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

// A git config identity that is actually a COWORKER's (shared/handed-down machine):
// a match driven ONLY by git config must be confirmable — never silently selected.
const COWORKERS = [
  { name: 'mahmoud', email: 'mdraoui@liadtech.com' },
  { name: 'Alice', email: 'alice@a.com' },
];

test('soft match (git config = a coworker): does NOT auto-select; shows the list + skip', async () => {
  const { inq, asked } = fakeInquirer([
    { newName: 'y-rachek', newEmail: 'yrachek@liadtech.com' }, // operator's own email — not an author
    { youEmail: SKIP_IDENTITY_VALUE },                          // "None of these — skip"
  ]);
  const out = await runMappingWizard(COWORKERS, { gitName: 'mahmoud', gitEmail: 'mdraoui@liadtech.com', inquirer: inq });
  assert.equal(out.skipped, true, 'operator can escape the coworker identity');
  assert.deepEqual(out.entries, []);
  // The "which is you?" prompt was shown, pre-selecting the git-config author, with the skip option.
  assert.equal(asked.length, 2, 'a confirm list prompt appeared (not a silent auto-match)');
  const list = asked[1][0];
  assert.equal(list.default, 'mdraoui@liadtech.com', 'git-config author is pre-selected');
  assert.ok(list.choices.some((ch) => ch && ch.value === SKIP_IDENTITY_VALUE), 'skip option present');
});

test('soft match: confirming the pre-selected author proceeds with the rewrite', async () => {
  const { inq } = fakeInquirer([
    { newName: 'Mahmoud', newEmail: 'mahmoud@users.noreply.github.com' }, // genuinely mahmoud's new email
    { youEmail: 'mdraoui@liadtech.com' },                                 // yes, that's me
    { editTeam: false },
  ]);
  const out = await runMappingWizard(COWORKERS, { gitName: 'mahmoud', gitEmail: 'mdraoui@liadtech.com', inquirer: inq });
  assert.equal(out.skipped, false);
  assert.equal(out.entries[0].sourceEmail, 'mdraoui@liadtech.com');
  assert.equal(out.entries[0].email, 'mahmoud@users.noreply.github.com');
});
