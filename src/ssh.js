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

/**
 * Probe GitHub SSH auth. BatchMode so it never hangs on a prompt, a short timeout,
 * and accept-new so a first-time host key doesn't block. `runner` is injectable
 * (returns the combined output string) so this is fully testable offline.
 * @returns {{ok:boolean, user?:string, reason?:string}}
 */
export function checkGithubSsh({ runner, env } = {}) {
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=8', 'git@github.com'];
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
