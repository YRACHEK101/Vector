// ─────────────────────────────────────────────────────────────────────────────
// prereqs.js — programmatic host-dependency checks with human-readable guidance.
// The probe function is injectable so the checks can be unit-tested offline.
// ─────────────────────────────────────────────────────────────────────────────
import { spawnSync } from 'node:child_process';

/** Probe a command's version; returns the first output line, or null if unavailable. */
export function commandVersion(cmd, args = ['--version']) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    if (r.error || r.status !== 0) return null;
    return ((r.stdout || r.stderr || '').trim().split('\n')[0]) || null;
  } catch {
    return null;
  }
}

export const INSTALL_HELP = {
  git:
`git is not installed or not on your PATH. Install it:
  • macOS:          xcode-select --install   (or: brew install git)
  • Debian/Ubuntu:  sudo apt-get install git
  • Windows:        https://git-scm.com/download/win`,
  'git-filter-repo':
`git-filter-repo is not installed or not on your PATH. Install it, then re-run:
  • macOS:          brew install git-filter-repo
  • Debian/Ubuntu:  sudo apt-get install git-filter-repo
  • Any OS via pip: pip3 install --user git-filter-repo
  Verify with:      git filter-repo --version`,
};

/**
 * Check that git and git-filter-repo are available.
 * @param {object} [opts]
 * @param {(cmd:string,args:string[])=>(string|null)} [opts.probe] injectable version probe
 * @returns {{ok:boolean, results:Array, missing:Array}}
 */
export function checkPrerequisites({ probe = commandVersion } = {}) {
  const results = [
    {
      name: 'git',
      version: probe('git', ['--version']),
      help: INSTALL_HELP.git,
    },
    {
      name: 'git-filter-repo',
      version: probe('git', ['filter-repo', '--version']),
      help: INSTALL_HELP['git-filter-repo'],
    },
  ].map((r) => ({ ...r, ok: !!r.version }));

  const missing = results.filter((r) => !r.ok);
  return { ok: missing.length === 0, results, missing };
}

/** Throw a single, human-readable error if anything is missing (used at startup). */
export function assertPrerequisites(opts = {}) {
  const { ok, missing } = checkPrerequisites(opts);
  if (!ok) {
    const blocks = missing.map((m) => m.help).join('\n\n');
    throw new Error(`Missing required tool(s):\n\n${blocks}`);
  }
}
