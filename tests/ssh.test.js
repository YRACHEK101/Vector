import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseSshAuth, checkGithubSsh, formatSshStatus, SSH_SETUP_HELP,
  findSshKey, sshKeyGuidance, isAzureSshUrl, azureSshHost, parseAzureSshAuth, checkAzureSsh,
} from '../src/ssh.js';
import { isGithubSshUrl, ensureGithubSsh, ensureSshReady, migrate } from '../src/pipeline.js';
import { finalizeConfig } from '../src/config.js';

// The real GitHub success banner — note it arrives on a process that EXITS 1.
const SUCCESS = "Hi octocat! You've successfully authenticated, but GitHub does not provide shell access.";

// ── Unit — SSH output parsing (pure) ────────────────────────────────────────
test('parseSshAuth: exit-1 "successfully authenticated" is a SUCCESS, with username', () => {
  assert.deepEqual(parseSshAuth(SUCCESS), { ok: true, user: 'octocat' });
  // deploy-key style "Hi org/repo!" also parses
  assert.deepEqual(parseSshAuth("Hi acme/site! You've successfully authenticated, but GitHub does not provide shell access."),
    { ok: true, user: 'acme/site' });
});

test('parseSshAuth: permission denied → not ok, with reason', () => {
  const r = parseSshAuth('git@github.com: Permission denied (publickey).');
  assert.equal(r.ok, false);
  assert.match(r.reason, /Permission denied \(publickey\)/);
});

test('parseSshAuth: timeout / unreachable / empty / unknown → not ok', () => {
  assert.equal(parseSshAuth('ssh: connect to host github.com port 22: Operation timed out').ok, false);
  assert.equal(parseSshAuth('').ok, false);
  assert.match(parseSshAuth('').reason, /No response|timed out/i);
  assert.equal(parseSshAuth('some unexpected banner').ok, false);
  assert.match(parseSshAuth('Host key verification failed.').reason, /host key/i);
});

// ── Unit — the probe with an injected runner (no network) ────────────────────
test('checkGithubSsh: uses injected runner; success and failure both handled', () => {
  let argsSeen;
  const ok = checkGithubSsh({ runner: (a) => { argsSeen = a; return SUCCESS; } });
  assert.deepEqual(ok, { ok: true, user: 'octocat' });
  // it sends BatchMode + a timeout + the github target (never hangs on a prompt)
  assert.ok(argsSeen.includes('git@github.com'));
  assert.ok(argsSeen.join(' ').includes('BatchMode=yes'));

  const bad = checkGithubSsh({ runner: () => 'git@github.com: Permission denied (publickey).' });
  assert.equal(bad.ok, false);
});

// ── Unit — --check reporting (pure formatter) ────────────────────────────────
test('formatSshStatus: OK shows the username; FAILED includes the 3 setup steps', () => {
  const ok = formatSshStatus({ ok: true, user: 'octocat' });
  assert.equal(ok.level, 'ok');
  assert.match(ok.lines.join('\n'), /OK \(authenticated as octocat\)/);

  const bad = formatSshStatus({ ok: false, reason: 'Permission denied (publickey).' });
  assert.equal(bad.level, 'warn');
  const text = bad.lines.join('\n');
  assert.match(text, /FAILED/);
  assert.match(text, /ssh-keygen -t ed25519/);
  assert.match(text, /SSH and GPG keys/);
  assert.match(text, /ssh -T git@github\.com/);
});

test('SSH_SETUP_HELP contains the three documented steps', () => {
  assert.match(SSH_SETUP_HELP, /1\. ssh-keygen/);
  assert.match(SSH_SETUP_HELP, /2\. Add ~\/\.ssh\/id_ed25519\.pub/);
  assert.match(SSH_SETUP_HELP, /3\. Test:  ssh -T git@github\.com/);
});

// ── Unit — URL gate predicate ────────────────────────────────────────────────
test('isGithubSshUrl: true only for GitHub SSH URLs', () => {
  assert.equal(isGithubSshUrl('git@github.com:octo/repo.git'), true);
  assert.equal(isGithubSshUrl('ssh://git@github.com/octo/repo.git'), true);
  assert.equal(isGithubSshUrl('https://github.com/octo/repo'), false);
  assert.equal(isGithubSshUrl('/tmp/local/repo.git'), false);
  assert.equal(isGithubSshUrl(''), false);
});

// ── Unit — ensureGithubSsh gate (injected checker, no network) ───────────────
test('ensureGithubSsh: skips for non-GitHub targets and when disabled (no probe)', async () => {
  let called = false;
  const spy = () => { called = true; return { ok: false }; };
  assert.deepEqual(await ensureGithubSsh({ githubSsh: '/tmp/x.git', _sshCheck: spy }), { ok: true, skipped: true });
  assert.deepEqual(await ensureGithubSsh({ githubSsh: 'git@github.com:o/r.git', skipSshPreflight: true, _sshCheck: spy }), { ok: true, skipped: true });
  assert.equal(called, false, 'the checker is never invoked when skipped');
});

test('ensureGithubSsh: passes through a successful check', async () => {
  const res = await ensureGithubSsh({ githubSsh: 'git@github.com:o/r.git', _sshCheck: () => ({ ok: true, user: 'octocat' }) });
  assert.deepEqual(res, { ok: true, user: 'octocat' });
});

test('ensureGithubSsh: throws with setup guidance on failure', async () => {
  await assert.rejects(
    () => ensureGithubSsh({ githubSsh: 'git@github.com:o/r.git', _sshCheck: () => ({ ok: false, reason: 'Permission denied (publickey).' }) }),
    (e) => {
      assert.match(e.message, /GitHub SSH preflight failed/);
      assert.match(e.message, /ssh-keygen -t ed25519/); // includes the fix steps
      return true;
    },
  );
});

// ── Unit — pipeline gate wiring: fail aborts before any work; pass proceeds ──
test('migrate: a failed SSH check aborts BEFORE mirroring/pushing', async () => {
  const WS = mkdtempSync(join(tmpdir(), 'vector-ssh-'));
  try {
    const cfg = finalizeConfig({
      azureUrl: '/does/not/matter', githubSsh: 'git@github.com:o/r.git', project: 'p',
      oldEmail: 'o@c.com', newName: 'N', newEmail: 'n@x.com',
    }, { cwd: WS });
    cfg._sshCheck = () => ({ ok: false, reason: 'Permission denied (publickey).' });

    await assert.rejects(() => migrate(cfg), /GitHub SSH preflight failed/);
    assert.equal(existsSync(cfg.sourceMirror), false, 'no mirror was created — it stopped before stage 1');
  } finally {
    rmSync(WS, { recursive: true, force: true });
  }
});

test('migrate: a passing SSH check proceeds PAST the gate (then fails later, not on SSH)', async () => {
  const WS = mkdtempSync(join(tmpdir(), 'vector-ssh-'));
  try {
    let called = false;
    const cfg = finalizeConfig({
      azureUrl: join(WS, 'nonexistent-azure.git'), // local clone fails fast, offline
      githubSsh: 'git@github.com:o/r.git', project: 'p',
      oldEmail: 'o@c.com', newName: 'N', newEmail: 'n@x.com',
    }, { cwd: WS });
    cfg._sshCheck = () => { called = true; return { ok: true, user: 'octocat' }; };

    await assert.rejects(() => migrate(cfg), (e) => {
      assert.ok(!/GitHub SSH preflight failed/.test(e.message), 'it got past the SSH gate');
      return true; // failure is the (expected) clone error, proving it proceeded
    });
    assert.equal(called, true, 'the SSH check ran');
  } finally {
    rmSync(WS, { recursive: true, force: true });
  }
});

// ── v2 — SSH key detection (present vs absent) ───────────────────────────────
test('findSshKey: detects an explicit key, a ~/.ssh key, ssh-agent, or none', () => {
  // explicit path wins when it exists
  assert.deepEqual(
    findSshKey({ explicitKey: '/keys/deploy', fileExists: (p) => p === '/keys/deploy', agentHasKey: () => false }),
    { found: true, source: 'explicit', path: '/keys/deploy' },
  );
  // a standard ~/.ssh key (private OR .pub present)
  const viaFile = findSshKey({ home: '/home/me', fileExists: (p) => p === '/home/me/.ssh/id_ed25519.pub', agentHasKey: () => false });
  assert.equal(viaFile.found, true);
  assert.equal(viaFile.source, 'file');
  // nothing on disk but the agent holds a key
  assert.deepEqual(findSshKey({ home: '/empty', fileExists: () => false, agentHasKey: () => true }), { found: true, source: 'agent' });
  // truly absent
  assert.deepEqual(findSshKey({ home: '/empty', fileExists: () => false, agentHasKey: () => false }), { found: false });
});

test('sshKeyGuidance: includes the rsa 4096 command and OS-correct "show key" command', () => {
  const win = sshKeyGuidance({ platform: 'win32' });
  assert.match(win, /ssh-keygen -t rsa -b 4096 -C/);   // the exact command requested
  assert.match(win, /ssh-keygen -t ed25519/);          // modern alternative mentioned
  assert.match(win, /type %USERPROFILE%\\\.ssh\\id_rsa\.pub/); // cmd-friendly
  assert.match(win, /Azure DevOps/);
  assert.match(win, /GitHub/);

  const nix = sshKeyGuidance({ platform: 'darwin' });
  assert.match(nix, /cat ~\/\.ssh\/id_rsa\.pub/);       // bash/macOS friendly
  assert.match(nix, /ssh-keygen -t rsa -b 4096 -C/);
});

// ── v2 — Azure SSH gating + parsing ──────────────────────────────────────────
test('isAzureSshUrl / azureSshHost: true only for Azure SSH urls; host extracted', () => {
  assert.equal(isAzureSshUrl('git@ssh.dev.azure.com:v3/org/proj/repo'), true);
  assert.equal(isAzureSshUrl('ssh://git@ssh.dev.azure.com/v3/org/proj/repo'), true);
  assert.equal(isAzureSshUrl('https://org@dev.azure.com/org/proj/_git/repo'), false);
  assert.equal(isAzureSshUrl(''), false);
  assert.equal(azureSshHost('git@ssh.dev.azure.com:v3/org/proj/repo'), 'ssh.dev.azure.com');
});

test('parseAzureSshAuth: permission-denied fails; a non-failing banner authenticates', () => {
  assert.equal(parseAzureSshAuth('git@ssh.dev.azure.com: Permission denied (publickey).').ok, false);
  assert.equal(parseAzureSshAuth('remote: Shell access is not supported.').ok, true);
  assert.equal(parseAzureSshAuth('').ok, false);
  assert.match(parseAzureSshAuth('Host key verification failed.').reason, /host key/i);
});

test('checkAzureSsh: targets the given host with BatchMode (no hang), via injected runner', () => {
  let argsSeen;
  const r = checkAzureSsh({ host: 'ssh.dev.azure.com', runner: (a) => { argsSeen = a; return 'remote: Shell access is not supported.'; } });
  assert.equal(r.ok, true);
  assert.ok(argsSeen.includes('git@ssh.dev.azure.com'));
  assert.ok(argsSeen.join(' ').includes('BatchMode=yes'));
});

// ── v2 — ensureSshReady orchestration (all IO injected, no network) ──────────
test('ensureSshReady: missing key throws the ssh-keygen guidance, before any clone', async () => {
  await assert.rejects(
    () => ensureSshReady(
      { githubSsh: 'git@github.com:o/r.git', azureUrl: 'https://org@dev.azure.com/o/p/_git/r' },
      undefined,
      { findSshKey: () => ({ found: false }), trustHost: () => ({}) },
    ),
    (e) => { assert.match(e.message, /ssh-keygen -t rsa -b 4096/); return true; },
  );
});

test('ensureSshReady: HTTPS Azure source skips Azure SSH, verifies GitHub only', async () => {
  let azureChecked = false;
  const res = await ensureSshReady(
    { githubSsh: 'git@github.com:o/r.git', azureUrl: 'https://org@dev.azure.com/o/p/_git/r' },
    undefined,
    {
      findSshKey: () => ({ found: true, source: 'file', path: '/k' }),
      trustHost: () => ({}),
      githubCheck: () => ({ ok: true, user: 'octocat' }),
      azureCheck: () => { azureChecked = true; return { ok: true }; },
    },
  );
  assert.equal(res.ok, true);
  assert.equal(res.needAzure, false);
  assert.equal(azureChecked, false, 'an HTTPS Azure source is never SSH-probed');
});

test('ensureSshReady: SSH Azure source is verified; failure explains the HTTPS fallback', async () => {
  await assert.rejects(
    () => ensureSshReady(
      { githubSsh: 'git@github.com:o/r.git', azureUrl: 'git@ssh.dev.azure.com:v3/org/proj/repo' },
      undefined,
      {
        findSshKey: () => ({ found: true, source: 'agent' }),
        trustHost: () => ({}),
        githubCheck: () => ({ ok: true, user: 'octocat' }),
        azureCheck: () => ({ ok: false, reason: 'Permission denied (publickey).' }),
      },
    ),
    (e) => {
      assert.match(e.message, /Azure DevOps SSH preflight failed/);
      assert.match(e.message, /Switch the Azure source URL to HTTPS/);
      return true;
    },
  );
});

test('ensureSshReady: skips entirely when disabled', async () => {
  assert.deepEqual(await ensureSshReady({ skipSshPreflight: true }), { ok: true, skipped: true });
});
