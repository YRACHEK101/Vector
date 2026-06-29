// ─────────────────────────────────────────────────────────────────────────────
// largefiles.js — detect and describe blobs that exceed GitHub's per-file size
// limit (100 MB by default), anywhere in history, so we can remediate BEFORE the
// push instead of failing at it.
//
// Sizes are MiB-based (1024²): this matches both GitHub's own "182.19 MB" display
// and git-filter-repo's `--strip-blobs-bigger-than <N>M` (which also uses 1024).
// Pure parsers/formatters live alongside the streaming scanner so the logic is
// unit-testable offline; the only IO is the rev-list│cat-file pipe and a git-lfs
// version probe.
// ─────────────────────────────────────────────────────────────────────────────
import { spawn } from 'node:child_process';
import { gitDir } from './git.js';
import { commandVersion } from './prereqs.js';

const noop = () => {};

/** Megabytes (MiB) → bytes. The single source of truth for the byte threshold. */
export function mbToBytes(mb) {
  const n = Number(mb);
  return Math.round((Number.isFinite(n) ? n : 0) * 1024 * 1024);
}

/** Human-readable byte size, 1024-based: 191031296 → "182.19 MB". */
export function formatBytes(bytes) {
  const b = Number(bytes) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = b;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${i === 0 ? String(Math.round(n)) : n.toFixed(2)} ${units[i]}`;
}

/**
 * Pure: parse ONE `git cat-file --batch-check` line and return the blob if it is
 * over the limit, else null. Expected line shape (from the batch-check format
 * "%(objecttype) %(objectname) %(objectsize) %(rest)"):
 *   "blob <oid> <size> <path…>"   ·   non-blobs and under-limit blobs → null.
 * The limit is exclusive (strictly larger), matching GitHub ("larger than 100 MiB")
 * and git-filter-repo's strip semantics.
 */
export function parseLargeBlobLine(line, limitBytes) {
  const m = String(line).match(/^(\S+) (\S+) (\d+)(?: (.*))?$/);
  if (!m) return null;
  const [, type, oid, sizeStr, rest] = m;
  if (type !== 'blob') return null;
  const size = parseInt(sizeStr, 10);
  if (!(size > limitBytes)) return null;
  const path = (rest && rest.length) ? rest : `(blob ${oid.slice(0, 10)})`;
  return { oid, size, path };
}

/**
 * Pure: parse a whole `cat-file --batch-check` dump into the offending blobs,
 * de-duplicated by path (a path that changed across history keeps its largest
 * size) and sorted largest-first.
 */
export function parseLargeBlobs(text, limitBytes) {
  const byPath = new Map();
  for (const line of String(text).split('\n')) {
    const o = parseLargeBlobLine(line, limitBytes);
    if (!o) continue;
    const prev = byPath.get(o.path);
    if (!prev || o.size > prev.size) byPath.set(o.path, o);
  }
  return [...byPath.values()].sort((a, b) => b.size - a.size);
}

/**
 * Stream the full object graph of a bare mirror and return blobs over the limit.
 * Uses `git rev-list --objects --all | git cat-file --batch-check`, parsing line
 * by line and keeping only offenders, so memory stays bounded on huge repos and
 * nothing is ever checked out. Resolves to [] on any git error (the caller treats
 * "couldn't scan" as "nothing to remediate" and proceeds as before).
 */
export function scanLargeBlobs(dir, limitBytes, { env } = {}) {
  return new Promise((resolve) => {
    const gd = gitDir(dir);
    const full = { ...process.env, ...(env || {}) };
    let settled = false;
    const finish = (val) => { if (!settled) { settled = true; resolve(val); } };

    let rev;
    let cat;
    try {
      rev = spawn('git', [...gd, 'rev-list', '--objects', '--all'], { env: full });
      cat = spawn('git', [...gd, 'cat-file', '--batch-check=%(objecttype) %(objectname) %(objectsize) %(rest)'], { env: full });
    } catch {
      return finish([]);
    }

    rev.on('error', () => finish([]));
    cat.on('error', () => finish([]));
    rev.stdout.on('error', noop);
    cat.stdin.on('error', noop); // EPIPE if cat exits first — harmless
    rev.stdout.pipe(cat.stdin);

    const byPath = new Map();
    let buf = '';
    const take = (line) => {
      const o = parseLargeBlobLine(line, limitBytes);
      if (!o) return;
      const prev = byPath.get(o.path);
      if (!prev || o.size > prev.size) byPath.set(o.path, o);
    };
    cat.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        take(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    cat.on('close', () => {
      if (buf) take(buf);
      finish([...byPath.values()].sort((a, b) => b.size - a.size));
    });
  });
}

/**
 * Pure: the one-line offender report, matching the spec's wording exactly:
 *   "Found 1 file exceeding GitHub's 100 MB limit: Cursor-1.0.0-x86_64.AppImage (182.19 MB)"
 */
export function formatOffenders(offenders = [], limitMb = 100) {
  const n = offenders.length;
  const list = offenders.map((o) => `${o.path} (${formatBytes(o.size)})`).join(', ');
  return `Found ${n} file${n === 1 ? '' : 's'} exceeding GitHub's ${limitMb} MB limit: ${list}`;
}

/**
 * Pure: resolve the effective action BEFORE prompting.
 *   explicit strip|lfs|abort → honored as-is;
 *   "prompt"                 → 'prompt' when a prompter exists, else 'strip';
 *   unset                    → 'prompt' when a prompter exists (interactive), else
 *                              'strip' (non-interactive / --force / CI: just fix it).
 * @returns {'strip'|'lfs'|'abort'|'prompt'}
 */
export function defaultLargeFileAction({ requested = '', hasPrompter = false } = {}) {
  const r = String(requested || '').trim().toLowerCase();
  if (r === 'strip' || r === 'lfs' || r === 'abort') return r;
  if (r === 'prompt') return hasPrompter ? 'prompt' : 'strip';
  return hasPrompter ? 'prompt' : 'strip';
}

/** Suggest `.gitignore` patterns from the offenders' extensions (e.g. "*.AppImage"). */
export function suggestGitignore(offenders = []) {
  const out = new Set();
  for (const o of offenders) {
    const base = String(o.path).split('/').pop() || '';
    const dot = base.lastIndexOf('.');
    if (dot > 0 && dot < base.length - 1) out.add(`*${base.slice(dot)}`);
  }
  return [...out];
}

/** Is git-lfs installed and callable? (probe injectable for offline tests.) */
export function gitLfsAvailable({ probe = commandVersion } = {}) {
  return !!probe('git', ['lfs', 'version']);
}

export const LFS_INSTALL_HELP =
  'Install git-lfs to use --on-large-file lfs:\n'
  + '  • macOS:          brew install git-lfs && git lfs install\n'
  + '  • Debian/Ubuntu:  sudo apt-get install git-lfs && git lfs install\n'
  + '  • Windows:        https://git-lfs.github.com';

/**
 * Pure: recognise GitHub's oversized-file push rejection in a push's stderr and
 * pull out the named files. Matches the GH001 marker and the per-file lines:
 *   "remote: error: File X is 182.19 MB; this exceeds GitHub's file size limit of 100.00 MB"
 * @returns {{matched:boolean, files:Array<{path:string,size:string}>}}
 */
export function parseGH001(stderr = '') {
  const text = String(stderr);
  const matched = /GH001|exceeds GitHub'?s file size limit|Large files detected/i.test(text);
  const files = [];
  const re = /File\s+(.+?)\s+is\s+([\d.]+\s*[KMGT]?B);/gi;
  let m;
  while ((m = re.exec(text))) files.push({ path: m[1].trim(), size: m[2].replace(/\s+/g, ' ').trim() });
  return { matched, files };
}

/** Pure: a plain-language replacement for the raw "git push exited with code 1". */
export function formatGH001Guidance(parsed = { files: [] }, { maxFileSizeMb = 100 } = {}) {
  const list = (parsed.files && parsed.files.length)
    ? parsed.files.map((f) => `  • ${f.path} (${f.size})`).join('\n') + '\n'
    : '';
  return (
    `GitHub rejected the push: one or more files exceed its ${maxFileSizeMb} MB limit somewhere in history.\n`
    + list
    + 'Re-run Vector to fix this automatically:\n'
    + '  • --on-large-file strip   remove the oversized file(s) from ALL history, then push (default with --force)\n'
    + '  • --on-large-file lfs     move them to Git LFS instead (needs git-lfs)\n'
    + '  • --on-large-file abort   stop without changing history (default in interactive mode)\n'
    + 'Tune the threshold with --max-file-size <MB> (default 100).'
  );
}
