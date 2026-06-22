// v2.1 — SSH multi-key detection + accurate, OS-correct failure guidance.
// Fully offline: ssh, the filesystem, and ssh-agent are all injected. These lock
// in the exact Windows-cmd scenario a colleague hit (a key on disk that wasn't
// registered with GitHub).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkGithubSsh, sshKeyGuidance, sshAuthFailureGuidance, listLocalSshKeys,
} from '../src/ssh.js';
import { ensureSshReady } from '../src/pipeline.js';

const GH = 'git@github.com:o/r.git';
const HTTPS_AZURE = 'https://org@dev.azure.com/o/p/_git/r'; // HTTPS → no Azure SSH probe
const DENIED = 'Permission denied (publickey) — no SSH key is registered with your GitHub account.';
const SUCCESS = "Hi octocat! You've successfully authenticated, but GitHub does not provide shell access.";

// Base deps so ensureSshReady never touches the real network / filesystem.
const baseDeps = (over = {}) => ({
  trustHost: () => ({}),
  findSshKey: () => ({ found: true, source: 'file' }),
  listLocalSshKeys: () => ['id_ed25519.pub', 'id_rsa.pub'],
  ...over,
});

// ── Scenario 1 — key present but UNREGISTERED (the colleague's exact case) ────
test('key present but unregistered: fails before clone; lists all keys + Windows print cmd + settings link', async () => {
  await assert.rejects(
    () => ensureSshReady(
      { githubSsh: GH, azureUrl: HTTPS_AZURE },
      undefined,
      baseDeps({ platform: 'win32', githubCheck: () => ({ ok: false, reason: DENIED }) }),
    ),
    (e) => {
      const m = e.message;
      assert.match(m, /GitHub SSH preflight failed/);
      assert.match(m, /NONE of them is registered/);
      assert.match(m, /type %USERPROFILE%\\\.ssh\\id_ed25519\.pub/); // every key, cmd-rendered
      assert.match(m, /type %USERPROFILE%\\\.ssh\\id_rsa\.pub/);
      assert.match(m, /https:\/\/github\.com\/settings\/keys/);      // direct registration link
      assert.doesNotMatch(m, /ssh-keygen -t rsa/);                   // not the "generate" message — a key exists
      return true;
    },
  );
});

// ── Scenario 2 — key present AND registered → passes ─────────────────────────
test('key present and registered: preflight passes', async () => {
  const res = await ensureSshReady(
    { githubSsh: GH, azureUrl: HTTPS_AZURE },
    undefined,
    baseDeps({ githubCheck: () => ({ ok: true, user: 'octocat' }) }),
  );
  assert.equal(res.ok, true);
  assert.equal(res.needGithub, true);
});

// ── Scenario 3 — multiple keys present; either may authenticate ──────────────
test('multiple keys: all are offered to ssh (IdentitiesOnly=no), and either authenticating passes', () => {
  // listLocalSshKeys enumerates BOTH default pairs that exist on disk.
  const dir = '/home/me/.ssh';
  const keys = listLocalSshKeys({
    home: '/home/me',
    fileExists: (p) => p === `${dir}/id_ed25519` || p === `${dir}/id_rsa`,
    readdir: () => ['id_ed25519', 'id_ed25519.pub', 'id_rsa', 'id_rsa.pub', 'config'],
  });
  assert.deepEqual(keys, ['id_ed25519.pub', 'id_rsa.pub']);

  // With no forced key, the probe offers the agent + every default identity.
  let seen;
  checkGithubSsh({ runner: (a) => { seen = a; return SUCCESS; } });
  assert.ok(seen.join(' ').includes('IdentitiesOnly=no'), 'ssh offers all identities, not just one');
})

test('multiple keys: preflight passes as soon as one key authenticates', async () => {
  const res = await ensureSshReady(
    { githubSsh: GH, azureUrl: HTTPS_AZURE },
    undefined,
    baseDeps({ githubCheck: () => ({ ok: true, user: 'octocat' }) }), // ssh accepted one of them
  );
  assert.equal(res.ok, true);
});

// ── Scenario 4 — NO key at all → generation guidance, stop before clone ──────
test('no key at all: shows ssh-keygen -t rsa -b 4096 guidance and stops before the clone', async () => {
  await assert.rejects(
    () => ensureSshReady(
      { githubSsh: GH, azureUrl: HTTPS_AZURE },
      undefined,
      baseDeps({ findSshKey: () => ({ found: false }) }),
    ),
    (e) => {
      assert.match(e.message, /ssh-keygen -t rsa -b 4096/);
      assert.match(e.message, /No SSH key found/);
      return true;
    },
  );
});

// ── Scenario 5 — OS-correct rendering of the failure guidance ────────────────
test('OS rendering: win32 uses %USERPROFILE% + type; posix uses ~ + cat', () => {
  const win = sshAuthFailureGuidance({ platform: 'win32', keys: ['id_rsa.pub'], service: 'github' });
  assert.match(win, /type %USERPROFILE%\\\.ssh\\id_rsa\.pub/);
  assert.doesNotMatch(win, /cat ~\//);

  const nix = sshAuthFailureGuidance({ platform: 'linux', keys: ['id_rsa.pub'], service: 'github' });
  assert.match(nix, /cat ~\/\.ssh\/id_rsa\.pub/);
  assert.doesNotMatch(nix, /%USERPROFILE%/);

  // Azure variant keeps the HTTPS fallback and Azure registration path.
  const az = sshAuthFailureGuidance({ platform: 'win32', keys: ['id_ed25519.pub'], service: 'azure' });
  assert.match(az, /Azure DevOps SSH preflight failed/);
  assert.match(az, /Switch the Azure source URL to HTTPS/);
  assert.match(az, /SSH public keys/);

  // The generate-a-key guidance is also OS-correct.
  assert.match(sshKeyGuidance({ platform: 'win32' }), /type %USERPROFILE%\\\.ssh\\id_rsa\.pub/);
  assert.match(sshKeyGuidance({ platform: 'darwin' }), /cat ~\/\.ssh\/id_rsa\.pub/);
});

// ── Scenario 6 — --ssh-key forces that exact key ─────────────────────────────
test('--ssh-key forces the given key (-i + IdentitiesOnly=yes) in the probe', async () => {
  let passedKeyPath;
  const res = await ensureSshReady(
    { githubSsh: GH, azureUrl: HTTPS_AZURE, sshKey: '/keys/mykey' },
    undefined,
    baseDeps({
      findSshKey: () => ({ found: true, source: 'explicit', path: '/keys/mykey' }),
      fileExists: (p) => p === '/keys/mykey',
      githubCheck: ({ keyPath }) => { passedKeyPath = keyPath; return { ok: true, user: 'octocat' }; },
    }),
  );
  assert.equal(res.ok, true);
  assert.equal(passedKeyPath, '/keys/mykey', 'the explicit key is forced into the probe');

  // And the probe builds the right ssh args for a forced key.
  let seen;
  checkGithubSsh({ keyPath: '/keys/mykey', runner: (a) => { seen = a; return SUCCESS; } });
  assert.ok(seen.includes('-i') && seen.includes('/keys/mykey'));
  assert.ok(seen.join(' ').includes('IdentitiesOnly=yes'));
});

test('--ssh-key that does not exist fails fast with a clear message', async () => {
  await assert.rejects(
    () => ensureSshReady(
      { githubSsh: GH, azureUrl: HTTPS_AZURE, sshKey: '/no/such/key' },
      undefined,
      baseDeps({ fileExists: () => false }),
    ),
    /--ssh-key path not found: \/no\/such\/key/,
  );
});
