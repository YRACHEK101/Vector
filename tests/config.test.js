import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveProjectSlug, parseBranches, parseEmails, buildMailmap,
  configFromEnv, mergeConfigs, validateConfig, finalizeConfig, DEFAULT_BRANCHES,
} from '../src/config.js';

test('deriveProjectSlug pulls REPO from a GitHub SSH URL', () => {
  assert.equal(deriveProjectSlug('git@github.com:octocat/My-Repo.git'), 'My-Repo');
  assert.equal(deriveProjectSlug('git@github.com:octocat/My-Repo'), 'My-Repo');
  assert.equal(deriveProjectSlug(''), '');
});

test('parseBranches accepts arrays, comma/space strings, and defaults to [master, main]', () => {
  assert.deepEqual(parseBranches(['a', ' b ', '']), ['a', 'b']);
  assert.deepEqual(parseBranches('main, develop  feature/x'), ['main', 'develop', 'feature/x']);
  assert.deepEqual(parseBranches(''), DEFAULT_BRANCHES);
  assert.deepEqual(parseBranches(undefined), ['master', 'main']);
});

test('parseEmails normalizes arrays and delimited strings', () => {
  assert.deepEqual(parseEmails('a@x.com, b@y.com'), ['a@x.com', 'b@y.com']);
  assert.deepEqual(parseEmails(['a@x.com', '']), ['a@x.com']);
  assert.deepEqual(parseEmails(''), []);
});

test('buildMailmap emits one Name <new> <old> line per old email', () => {
  const mm = buildMailmap('Octo', 'me@me.com', ['old@corp.com', 'old2@corp.com']);
  assert.equal(mm, 'Octo <me@me.com> <old@corp.com>\nOcto <me@me.com> <old2@corp.com>\n');
  assert.equal(buildMailmap('Octo', 'me@me.com', []), '');
});

test('configFromEnv reads SCREAMING_CASE env into camelCase', () => {
  const cfg = configFromEnv({
    PROJECT: 'p', OLD_EMAIL: 'o@x', NEW_NAME: 'n', NEW_EMAIL: 'n@x',
    AZURE_URL: 'https://a', GITHUB_SSH: 'git@github.com:u/r.git',
    PUSH_BRANCHES: 'main develop', EXTRA_OLD_EMAILS: 'e1@x, e2@x',
  });
  assert.equal(cfg.project, 'p');
  assert.deepEqual(cfg.branches, ['main', 'develop']);
  assert.deepEqual(cfg.extraOldEmails, ['e1@x', 'e2@x']);
});

test('mergeConfigs lets later non-empty values win, ignoring empties', () => {
  const merged = mergeConfigs(
    { project: 'a', newName: 'x', branches: ['main'] },
    { project: '', newName: 'y', branches: [] },
  );
  assert.equal(merged.project, 'a');     // '' did not override
  assert.equal(merged.newName, 'y');     // non-empty overrode
  assert.deepEqual(merged.branches, ['main']); // empty array did not override
});

test('validateConfig flags missing required fields and malformed values', () => {
  const bad = validateConfig({ azureUrl: '', githubSsh: 'https://github.com/u/r', newEmail: 'nope' });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes('azureUrl')));
  assert.ok(bad.errors.some((e) => e.includes('githubSsh should be an SSH URL')));
  assert.ok(bad.errors.some((e) => e.includes('newEmail')));

  const good = validateConfig({
    azureUrl: 'https://a', githubSsh: 'git@github.com:u/r.git',
    oldEmail: 'o@x.com', newName: 'n', newEmail: 'n@x.com',
  });
  assert.equal(good.ok, true);
});

test('finalizeConfig derives slug, mirror paths, and de-duped old emails', () => {
  const final = finalizeConfig(
    {
      githubSsh: 'git@github.com:u/cool-repo.git', oldEmail: 'o@x.com',
      extraOldEmails: ['e@x.com'], newName: 'n', newEmail: 'n@x.com', branches: [],
    },
    { cwd: '/tmp/work' },
  );
  assert.equal(final.project, 'cool-repo');
  assert.deepEqual(final.branches, ['master', 'main']);
  assert.deepEqual(final.allOldEmails, ['o@x.com', 'e@x.com']);
  // Staging now lives under a single work dir (default ./.vector-staging) so the host stays tidy.
  assert.equal(final.workDir, '/tmp/work/.vector-staging');
  assert.equal(final.sourceMirror, '/tmp/work/.vector-staging/cool-repo-source.git');
  assert.equal(final.stagingMirror, '/tmp/work/.vector-staging/cool-repo-migration.git');
  assert.match(final.gitEnv.GIT_SSH_COMMAND, /BatchMode=yes/);
});

test('finalizeConfig honors --work-dir override for all staging paths', () => {
  const final = finalizeConfig(
    { githubSsh: 'git@github.com:u/cool-repo.git', workDir: '/custom/stage' },
    { cwd: '/tmp/work' },
  );
  assert.equal(final.workDir, '/custom/stage');
  assert.equal(final.sourceMirror, '/custom/stage/cool-repo-source.git');
  assert.equal(final.stagingMirror, '/custom/stage/cool-repo-migration.git');
  assert.equal(final.mailmapFile, '/custom/stage/cool-repo-mailmap.txt');
});
