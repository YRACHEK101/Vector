// ─────────────────────────────────────────────────────────────────────────────
// git.js — thin, dependency-free wrappers around child_process for git.
// ─────────────────────────────────────────────────────────────────────────────
import { spawn, spawnSync } from 'node:child_process';

/**
 * Run a command to completion. By default it inherits stdio (so progress shows
 * live); pass { capture: true } to buffer stdout/stderr instead. Rejects with a
 * rich Error (carrying cmd/args/code/stderr) on non-zero exit or spawn failure.
 */
export function run(cmd, args, { cwd, env, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
    });
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
    }
    child.on('error', (e) =>
      reject(Object.assign(new Error(`Failed to start "${cmd}": ${e.message}`), { cmd, args })));
    child.on('close', (code) => {
      if (code === 0) return resolve({ code, stdout, stderr });
      const tail = stderr ? `\n${stderr.trim()}` : '';
      reject(Object.assign(new Error(`"${cmd} ${args.join(' ')}" exited with code ${code}${tail}`),
        { cmd, args, code, stdout, stderr }));
    });
  });
}

/** Convenience: run and capture combined output. */
export function runCapture(cmd, args, opts = {}) {
  return run(cmd, args, { ...opts, capture: true });
}

/** Synchronous query → trimmed stdout, or null if the command failed. */
export function query(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts, env: { ...process.env, ...(opts.env || {}) } });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || '').trim();
}

/** Synchronous status code (used for boolean checks like merge-base --is-ancestor). */
export function status(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { ...opts, env: { ...process.env, ...(opts.env || {}) } });
  return r.status;
}

/**
 * Leading git args for operating on one of OUR bare mirrors. We pass an explicit
 * --git-dir (required under safe.bareRepository=explicit) and trust this specific
 * repo via -c safe.bareRepository=all, which also propagates to git-filter-repo's
 * child processes. We created these mirrors, so trusting them is correct.
 */
export function gitDir(dir) {
  return ['-c', 'safe.bareRepository=all', `--git-dir=${dir}`];
}

// ── Ref / OID / count helpers (used by the integrity engine and 0-commit fallback) ──

/** Map of every local branch + tag → its stored tip OID, in a bare mirror. */
export function refTips(dir) {
  const out = query('git', [...gitDir(dir), 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/', 'refs/tags/']) || '';
  const map = {};
  for (const line of out.split('\n')) {
    const [ref, oid] = line.trim().split(/\s+/);
    if (ref && oid) map[ref] = oid;
  }
  return map;
}

/** Map of a remote's branch + tag refs → tip OID via ls-remote (peeled "^{}" lines dropped). */
export function remoteRefTips(remote, { env } = {}) {
  const out = query('git', ['ls-remote', '--heads', '--tags', remote], { env }) || '';
  const map = {};
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^([0-9a-fA-F]+)\s+(\S+)$/);
    if (!m) continue;
    const [, oid, ref] = m;
    if (ref.endsWith('^{}')) continue; // peeled annotated-tag entry — keep the tag object oid only
    map[ref] = oid;
  }
  return map;
}

/** Total commit count across all refs (`git rev-list --count --all`); null if it fails. */
export function countAll(dir) {
  const n = query('git', [...gitDir(dir), 'rev-list', '--count', '--all']);
  return n == null ? null : (parseInt(n, 10) || 0);
}

/** Count of unique commits reachable from the given OIDs (objects must exist in `dir`). */
export function countReachable(dir, oids = []) {
  const list = [...new Set((oids || []).filter(Boolean))];
  if (!list.length) return 0;
  const n = query('git', [...gitDir(dir), 'rev-list', '--count', ...list]);
  return n == null ? null : (parseInt(n, 10) || 0);
}

/** Number of commits whose author OR committer email matches (case-insensitive), across all refs. */
export function commitsByEmail(dir, email) {
  const e = String(email ?? '').trim().toLowerCase();
  if (!e) return 0;
  const out = query('git', [...gitDir(dir), 'log', '--all', '--format=%ae%x09%ce']) || '';
  let count = 0;
  for (const line of out.split('\n')) {
    const [ae, ce] = line.split('\t');
    if ((ae && ae.toLowerCase() === e) || (ce && ce.toLowerCase() === e)) count += 1;
  }
  return count;
}
