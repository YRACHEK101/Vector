// ─────────────────────────────────────────────────────────────────────────────
// ssh.js — GitHub SSH preflight. Vector pushes over SSH (zero-token), so a missing
// SSH key only blows up at the push (stage 3) with "Permission denied (publickey)"
// after the mirror + rewrite already ran. We detect it up front instead.
//
// GitHub quirk: a SUCCESSFUL `ssh -T git@github.com` exits with code 1 and prints
//   "Hi <user>! You've successfully authenticated, but GitHub does not provide
//    shell access."
// So success is detected by the message, NEVER by exit code 0. The parsing is a
// pure function; the process call is injectable for offline tests.
// ─────────────────────────────────────────────────────────────────────────────
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export const SSH_SETUP_HELP =
`GitHub SSH is not set up. To fix:
  1. ssh-keygen -t ed25519 -C "you@example.com"      # press Enter for defaults
  2. Add ~/.ssh/id_ed25519.pub to GitHub → Settings → SSH and GPG keys → New SSH key
  3. Test:  ssh -T git@github.com`;

/**
 * Pure: interpret the combined stdout+stderr of `ssh -T git@github.com`.
 * @param {string} output
 * @returns {{ok:boolean, user?:string, reason?:string}}
 */
export function parseSshAuth(output) {
  const text = String(output ?? '');
  if (/successfully authenticated/i.test(text)) {
    const m = text.match(/Hi\s+([^!]+)!/i); // "Hi octocat! You've successfully authenticated…"
    return m ? { ok: true, user: m[1].trim() } : { ok: true };
  }
  if (/permission denied \(publickey\)/i.test(text)) {
    return { ok: false, reason: 'Permission denied (publickey) — no SSH key is registered with your GitHub account.' };
  }
  if (/host key verification failed/i.test(text)) {
    return { ok: false, reason: "GitHub's host key isn't trusted yet — run `ssh -T git@github.com` once to accept it." };
  }
  if (/command not found|not recognized|\bENOENT\b/i.test(text)) {
    return { ok: false, reason: 'ssh client not found on PATH.' };
  }
  if (/could not resolve hostname|connection timed out|operation timed out|network is unreachable|connection refused|timed out/i.test(text)) {
    return { ok: false, reason: 'Could not reach github.com over SSH (network issue or blocked port 22).' };
  }
  if (!text.trim()) {
    return { ok: false, reason: 'No response from ssh (timed out, or ssh is not installed).' };
  }
  return { ok: false, reason: `Unrecognized ssh response: "${text.trim().split('\n')[0]}"` };
}

/** Identity args for an ssh probe: force one key when given, else offer them all. */
function identityArgs(keyPath) {
  // With an explicit key, force ONLY it (-i + IdentitiesOnly=yes). Without one,
  // IdentitiesOnly=no lets ssh offer the agent AND every default identity file —
  // so the probe succeeds if ANY of the user's keys is registered, matching how
  // the real clone/push authenticates.
  return keyPath
    ? ['-i', keyPath, '-o', 'IdentitiesOnly=yes']
    : ['-o', 'IdentitiesOnly=no'];
}

/**
 * Probe GitHub SSH auth. BatchMode so it never hangs on a prompt, a short timeout,
 * and accept-new so a first-time host key doesn't block. Tries every local key /
 * the agent unless `keyPath` forces a specific one. `runner` is injectable
 * (returns the combined output string) so this is fully testable offline.
 * @returns {{ok:boolean, user?:string, reason?:string}}
 */
export function checkGithubSsh({ runner, env, keyPath } = {}) {
  const args = ['-T', '-o', 'BatchMode=yes', ...identityArgs(keyPath), '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=8', 'git@github.com'];
  const call = runner || ((a) => {
    const r = spawnSync('ssh', a, { encoding: 'utf8', timeout: 12000, env: { ...process.env, ...(env || {}) } });
    if (r.error && r.error.code === 'ENOENT') return 'ssh: command not found';
    return `${r.stdout || ''}${r.stderr || ''}`;
  });
  return parseSshAuth(call(args));
}

/** Pure: format an SSH check result for the `--check` report (level + lines). */
export function formatSshStatus(res) {
  if (res.ok) {
    return { level: 'ok', lines: [`GitHub SSH:  OK (authenticated as ${res.user || 'your account'})`] };
  }
  return { level: 'warn', lines: [`GitHub SSH:  FAILED — ${res.reason || 'unknown error'}`, '', SSH_SETUP_HELP] };
}

// ─────────────────────────────────────────────────────────────────────────────
// v2 — SSH KEY DETECTION + OS-specific key-generation guidance.
//
// Vector pushes (and, for SSH sources, fetches) over SSH. With no key at all the
// run only fails at the very end with "Permission denied (publickey)" — after a
// long mirror clone. We detect the key up front and, if it's missing, print the
// exact `ssh-keygen` command for the user's OS and stop before the clone.
// ─────────────────────────────────────────────────────────────────────────────

/** Does the local ssh-agent currently hold at least one identity? (exit 0 = yes). */
function defaultAgentHasKey() {
  const r = spawnSync('ssh-add', ['-l'], { encoding: 'utf8' });
  // 0 → has identities · 1 → agent running, no identities · 2 → no agent reachable.
  return !r.error && r.status === 0;
}

/**
 * Detect a usable SSH private key without prompting. Looks at (in order): an
 * explicitly-provided key path, the standard `~/.ssh/id_*` keys, then ssh-agent.
 * Every IO touch is injectable so this is fully testable offline.
 * @returns {{found:boolean, source?:'explicit'|'file'|'agent', path?:string}}
 */
export function findSshKey({ explicitKey = '', home, fileExists = existsSync, agentHasKey = defaultAgentHasKey } = {}) {
  if (explicitKey && fileExists(explicitKey)) return { found: true, source: 'explicit', path: explicitKey };
  const base = home || homedir();
  for (const name of ['id_ed25519', 'id_rsa', 'id_ecdsa']) {
    const priv = join(base, '.ssh', name);
    if (fileExists(priv) || fileExists(`${priv}.pub`)) return { found: true, source: 'file', path: priv };
  }
  if (agentHasKey()) return { found: true, source: 'agent' };
  return { found: false };
}

/**
 * Pure: OS-specific guidance for generating an SSH key and registering it with
 * BOTH Azure DevOps and GitHub. Windows (cmd) uses `%USERPROFILE%` + `type`;
 * bash/macOS uses `~` + `cat`.
 */
export function sshKeyGuidance({ platform = process.platform } = {}) {
  const showPub = platform === 'win32'
    ? 'type %USERPROFILE%\\.ssh\\id_rsa.pub'
    : 'cat ~/.ssh/id_rsa.pub';
  return [
    'No SSH key found. Vector authenticates over SSH (zero-token), so you need a key before migrating.',
    '',
    '1. Generate a key (press Enter at every prompt for the defaults):',
    '     ssh-keygen -t rsa -b 4096 -C "your-email@gmail.com"',
    '     (modern alternative:  ssh-keygen -t ed25519 -C "your-email")',
    '',
    '2. Print the PUBLIC key and copy it:',
    `     ${showPub}`,
    '',
    '3. Add that public key to BOTH services:',
    '     - Azure DevOps : User settings -> SSH public keys -> New Key',
    '     - GitHub       : Settings -> SSH and GPG keys -> New SSH key',
    '',
    '4. Re-run Vector.',
  ].join('\n');
}

/**
 * Enumerate the PUBLIC keys present in ~/.ssh: the standard pairs
 * (id_ed25519/id_rsa/id_ecdsa/id_dsa) plus any other `*.pub`. Returns sorted
 * `.pub` filenames. IO is injectable for offline tests.
 * @returns {string[]}
 */
export function listLocalSshKeys({ home, fileExists = existsSync, readdir } = {}) {
  const dir = join(home || homedir(), '.ssh');
  const names = new Set();
  for (const n of ['id_ed25519', 'id_rsa', 'id_ecdsa', 'id_dsa']) {
    if (fileExists(join(dir, n)) || fileExists(join(dir, `${n}.pub`))) names.add(`${n}.pub`);
  }
  const list = readdir || ((d) => { try { return readdirSync(d); } catch { return []; } });
  for (const f of list(dir)) {
    if (typeof f === 'string' && f.endsWith('.pub')) names.add(f);
  }
  return [...names].sort();
}

/**
 * Pure: precise guidance when SSH auth FAILS while a key exists — i.e. none of
 * the user's local keys is registered with the service. Names every local public
 * key with the exact OS-correct print command, says plainly that NONE is
 * registered, and links to the right place to register ONE of them. `service` is
 * 'github' (default) or 'azure'.
 */
export function sshAuthFailureGuidance({ platform = process.platform, keys = [], service = 'github', reason = '' } = {}) {
  const isWin = platform === 'win32';
  const printCmd = (name) => (isWin ? `type %USERPROFILE%\\.ssh\\${name}` : `cat ~/.ssh/${name}`);
  const svc = service === 'azure' ? 'Azure DevOps' : 'GitHub';
  const lines = [`${svc} SSH preflight failed: ${reason || 'Permission denied (publickey).'}`, ''];

  if (keys.length) {
    lines.push(`These local public key(s) were found, but NONE of them is registered with your ${svc} account:`);
    for (const k of keys) lines.push(`     ${printCmd(k)}      # prints ${k}`);
    lines.push('', `You must register ONE of the keys above with ${svc}:`);
  } else {
    lines.push(`ssh offered an agent identity that ${svc} rejected, and no public key files were found in ~/.ssh.`);
    lines.push('List your agent keys with:  ssh-add -l');
    lines.push('', `Register the matching public key with ${svc}:`);
  }

  if (service === 'azure') {
    lines.push('     Azure DevOps -> User settings -> SSH public keys -> New Key');
    lines.push('', 'Switch the Azure source URL to HTTPS to skip Azure SSH entirely, e.g.');
    lines.push('     https://ORG@dev.azure.com/ORG/PROJECT/_git/REPO');
  } else {
    lines.push('     GitHub -> Settings -> SSH and GPG keys -> New SSH key');
    lines.push('     Direct link: https://github.com/settings/keys');
  }
  lines.push('', 'Then re-run Vector.');
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// v2 — Azure DevOps SSH probing (only used when the SOURCE url is SSH).
// ─────────────────────────────────────────────────────────────────────────────

/** Does the Azure source URL use SSH (vs HTTPS)? Only then do we probe Azure SSH. */
export function isAzureSshUrl(url = '') {
  return /^(git@ssh\.dev\.azure\.com:|ssh:\/\/git@ssh\.dev\.azure\.com\/|git@vs-ssh\.[^:]+:|ssh:\/\/git@vs-ssh\.[^/]+\/)/i.test(String(url));
}

/** Extract the SSH host from an Azure SSH URL (defaults to ssh.dev.azure.com). */
export function azureSshHost(url = '') {
  const m = String(url).match(/@([^:/]+)/);
  return (m && m[1]) || 'ssh.dev.azure.com';
}

/**
 * Pure: interpret the combined output of `ssh -T git@ssh.dev.azure.com`. Azure's
 * success banner varies ("shell access is not supported" is canonical), so we
 * key off the explicit FAILURE signatures and treat anything else non-empty as
 * authenticated. Mirrors parseSshAuth's contract.
 */
export function parseAzureSshAuth(output) {
  const text = String(output ?? '');
  if (/permission denied \(publickey\)/i.test(text)) {
    return { ok: false, reason: 'Permission denied (publickey) — your SSH key is not registered with Azure DevOps.' };
  }
  if (/host key verification failed/i.test(text)) {
    return { ok: false, reason: "Azure DevOps' host key isn't trusted yet." };
  }
  if (/command not found|not recognized|\bENOENT\b/i.test(text)) {
    return { ok: false, reason: 'ssh client not found on PATH.' };
  }
  if (/could not resolve hostname|connection timed out|operation timed out|network is unreachable|connection refused|timed out/i.test(text)) {
    return { ok: false, reason: 'Could not reach Azure DevOps over SSH (network issue or blocked port 22).' };
  }
  if (!text.trim()) {
    return { ok: false, reason: 'No response from ssh (timed out, or ssh is not installed).' };
  }
  // No explicit failure signature on a non-empty banner → authenticated.
  return { ok: true };
}

/** Probe Azure DevOps SSH auth. BatchMode + accept-new + short timeout so it never hangs. */
export function checkAzureSsh({ runner, env, host = 'ssh.dev.azure.com', keyPath } = {}) {
  const args = ['-T', '-o', 'BatchMode=yes', ...identityArgs(keyPath), '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=8', `git@${host}`];
  const call = runner || ((a) => {
    const r = spawnSync('ssh', a, { encoding: 'utf8', timeout: 12000, env: { ...process.env, ...(env || {}) } });
    if (r.error && r.error.code === 'ENOENT') return 'ssh: command not found';
    return `${r.stdout || ''}${r.stderr || ''}`;
  });
  return parseAzureSshAuth(call(args));
}

/**
 * Best-effort, NEVER-throwing host-key trust. If the host is already in
 * known_hosts it's a no-op; otherwise it tries `ssh-keyscan` and appends the
 * result. Failure is fine — the clone/push also run with
 * StrictHostKeyChecking=accept-new, which trusts the host on first contact.
 * @returns {{trusted:boolean, already?:boolean, added?:boolean}}
 */
export function trustHost(host, { knownHostsFile, scanner, fileExists = existsSync } = {}) {
  try {
    const file = knownHostsFile || join(homedir(), '.ssh', 'known_hosts');
    if (fileExists(file) && readFileSync(file, 'utf8').includes(host)) {
      return { trusted: true, already: true };
    }
    const scan = scanner || ((h) => {
      const r = spawnSync('ssh-keyscan', ['-T', '5', h], { encoding: 'utf8' });
      return (!r.error && r.status === 0) ? (r.stdout || '') : '';
    });
    const keys = scan(host);
    if (keys && keys.trim()) {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, keys.endsWith('\n') ? keys : `${keys}\n`);
      return { trusted: true, added: true };
    }
  } catch { /* ignore — accept-new is the safety net */ }
  return { trusted: false };
}
