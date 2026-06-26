// ─────────────────────────────────────────────────────────────────────────────
// modes.js — pure routing logic (no IO): the three migration modes, source-host
// detection, and GitHub URL normalization (HTTPS ⇄ SSH). Everything here is
// deterministic and unit-tested.
//
//   Mode A — Azure DevOps ➔ GitHub, with identity/email rewrite
//   Mode B — Azure DevOps ➔ GitHub, mirror only (no rewrite)
//   Mode C — GitHub ➔ GitHub,       with identity/email rewrite
//
// The mode selects a STRATEGY ('rewrite' | 'mirror'); the 0-commit auto-fallback
// (config.js) can downgrade a rewrite strategy to mirror at runtime.
// ─────────────────────────────────────────────────────────────────────────────

/** Static metadata for each mode. `source` is the expected source host family. */
export const MODES = {
  a: { key: 'a', rewrite: true, source: 'azure', label: 'Azure DevOps ➔ GitHub  (identity / email rewriting)' },
  b: { key: 'b', rewrite: false, source: 'azure', label: 'Azure DevOps ➔ GitHub  (mirror only — no email rewriting)' },
  c: { key: 'c', rewrite: true, source: 'github', label: 'GitHub ➔ GitHub        (identity / email rewriting)' },
};

/** Validate/normalize a mode string to 'a' | 'b' | 'c'; throws on anything else. */
export function normalizeMode(s) {
  const k = String(s ?? '').trim().toLowerCase();
  if (k === 'a' || k === 'b' || k === 'c') return k;
  throw new Error(`Invalid --mode "${s}" (expected a, b, or c).`);
}

/** The execution strategy a mode maps to: 'rewrite' rewrites identities; 'mirror' copies verbatim. */
export function strategyForMode(mode) {
  return MODES[mode] && MODES[mode].rewrite ? 'rewrite' : 'mirror';
}

/** Extract the lowercased host from any git URL (scp-like "git@host:path" or "scheme://[user@]host/…"). */
export function hostOf(url = '') {
  const s = String(url).trim();
  const asUrl = s.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)/);
  if (asUrl) return asUrl[1].toLowerCase();
  const scp = s.match(/^(?:[^@/]+@)?([^/:]+):/); // user@host:path
  if (scp) return scp[1].toLowerCase();
  return '';
}

/** Classify a source URL by host family: 'azure' | 'github' | 'other'. */
export function detectHostKind(url = '') {
  const h = hostOf(url);
  if (!h) return 'other';
  if (h === 'ssh.dev.azure.com' || /(^|\.)dev\.azure\.com$/.test(h) || /\.visualstudio\.com$/.test(h)) return 'azure';
  if (h === 'github.com' || h === 'ssh.github.com') return 'github';
  return 'other';
}

/**
 * Parse a GitHub repo URL (HTTPS or SSH, scp-like or ssh://) into its parts.
 * Returns null when the URL is not recognizably a github.com repo.
 * @returns {{owner:string, repo:string, ssh:string, https:string}|null}
 */
export function parseGitHubUrl(url = '') {
  const s = String(url).trim();
  let path = null;
  let m;
  if ((m = s.match(/^[a-z]+:\/\/(?:[^@/]+@)?github\.com\/(.+)$/i))) path = m[1];        // https:// or ssh://
  else if ((m = s.match(/^(?:[^@/]+@)?github\.com:(.+)$/i))) path = m[1];               // scp-like git@github.com:owner/repo
  if (path == null) return null;
  path = path.replace(/\.git$/i, '').replace(/\/+$/, '');
  const parts = path.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts.slice(1).join('/');
  return { owner, repo, ssh: `git@github.com:${owner}/${repo}.git`, https: `https://github.com/${owner}/${repo}.git` };
}

/** Normalize a GitHub URL to a canonical form ('ssh' default, or 'https'); pass non-GitHub URLs through unchanged. */
export function normalizeGitHubUrl(url = '', form = 'ssh') {
  const p = parseGitHubUrl(url);
  if (!p) return String(url).trim();
  return form === 'https' ? p.https : p.ssh;
}

/** Infer a mode when the operator did not pass --mode: GitHub source ⇒ C; Azure ⇒ A (rewrite) or B (mirror). */
export function inferMode({ sourceKind = '', hasRewrite = false } = {}) {
  if (sourceKind === 'github') return 'c';
  return hasRewrite ? 'a' : 'b';
}

/**
 * Resolve the effective mode: an explicit --mode wins (validated); otherwise infer
 * from the source host and whether a rewrite mapping was supplied.
 */
export function resolveMode({ mode, source = '', hasRewrite = false } = {}) {
  if (mode != null && String(mode).trim() !== '') return normalizeMode(mode);
  return inferMode({ sourceKind: detectHostKind(source), hasRewrite });
}
