import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseSshAuth, checkGithubSsh, formatSshStatus, SSH_SETUP_HELP,
} from '../src/ssh.js';
import { isGithubSshUrl, ensureGithubSsh, migrate } from '../src/pipeline.js';
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
