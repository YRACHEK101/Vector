import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPrerequisites, assertPrerequisites, INSTALL_HELP } from '../src/prereqs.js';

test('checkPrerequisites reports OK when both tools probe successfully', () => {
  const probe = () => 'some version 1.2.3';
  const r = checkPrerequisites({ probe });
  assert.equal(r.ok, true);
  assert.equal(r.missing.length, 0);
  assert.deepEqual(r.results.map((x) => x.name), ['git', 'git-filter-repo']);
});

test('checkPrerequisites detects a missing git-filter-repo with human-readable help', () => {
  const probe = (cmd, args) => (args[0] === 'filter-repo' ? null : 'git version 2.40.0');
  const r = checkPrerequisites({ probe });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing.map((m) => m.name), ['git-filter-repo']);
  const help = r.missing[0].help;
  assert.match(help, /brew install git-filter-repo/);
  assert.match(help, /sudo apt-get install git-filter-repo/);
  assert.match(help, /pip3 install --user git-filter-repo/);
});

test('checkPrerequisites detects a missing git with install guidance', () => {
  const probe = () => null; // nothing found
  const r = checkPrerequisites({ probe });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing.map((m) => m.name).sort(), ['git', 'git-filter-repo']);
  assert.match(INSTALL_HELP.git, /git-scm\.com\/download\/win/);
});

test('assertPrerequisites throws a single readable error listing every missing tool', () => {
  const probe = () => null;
  assert.throws(
    () => assertPrerequisites({ probe }),
    (err) => {
      assert.match(err.message, /Missing required tool/);
      assert.match(err.message, /brew install git-filter-repo/);
      return true;
    },
  );
});

test('assertPrerequisites is silent when everything is present', () => {
  assert.doesNotThrow(() => assertPrerequisites({ probe: () => 'v1' }));
});
