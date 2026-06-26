// Unit tests for the pure routing/integrity logic: mode resolution, URL detection
// and normalization (modes.js), the 0-commit fallback decision (config.js), and the
// ref-set + tip-OID + count integrity comparison (integrity.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODES, normalizeMode, strategyForMode, hostOf, detectHostKind,
  parseGitHubUrl, normalizeGitHubUrl, inferMode, resolveMode,
} from '../src/modes.js';
import { decideRewriteStrategy } from '../src/config.js';
import { diffRefs, compareIntegrity, formatIntegrityReport } from '../src/integrity.js';

// ── Mode metadata + validation ────────────────────────────────────────────────
test('normalizeMode: accepts a/b/c (any case), rejects everything else', () => {
  assert.equal(normalizeMode('a'), 'a');
  assert.equal(normalizeMode('B'), 'b');
  assert.equal(normalizeMode(' c '), 'c');
  assert.throws(() => normalizeMode('d'), /Invalid --mode/);
  assert.throws(() => normalizeMode(''), /Invalid --mode/);
});

test('strategyForMode: A and C rewrite; B mirrors', () => {
  assert.equal(strategyForMode('a'), 'rewrite');
  assert.equal(strategyForMode('b'), 'mirror');
  assert.equal(strategyForMode('c'), 'rewrite');
  assert.equal(MODES.a.rewrite, true);
  assert.equal(MODES.b.rewrite, false);
});

// ── Host detection ────────────────────────────────────────────────────────────
test('hostOf + detectHostKind: Azure (HTTPS/SSH) and GitHub (HTTPS/SSH/scp)', () => {
  assert.equal(hostOf('https://x@dev.azure.com/org/proj/_git/repo'), 'dev.azure.com');
  assert.equal(hostOf('git@github.com:u/r.git'), 'github.com');
  assert.equal(hostOf('ssh://git@github.com/u/r.git'), 'github.com');
  assert.equal(hostOf('git@ssh.dev.azure.com:v3/org/proj/repo'), 'ssh.dev.azure.com');

  assert.equal(detectHostKind('https://dev.azure.com/org/proj/_git/repo'), 'azure');
  assert.equal(detectHostKind('git@ssh.dev.azure.com:v3/org/proj/repo'), 'azure');
  assert.equal(detectHostKind('https://myorg.visualstudio.com/_git/repo'), 'azure');
  assert.equal(detectHostKind('git@github.com:u/r.git'), 'github');
  assert.equal(detectHostKind('https://github.com/u/r.git'), 'github');
  assert.equal(detectHostKind('https://gitlab.com/u/r.git'), 'other');
  assert.equal(detectHostKind('/local/path/repo.git'), 'other');
});

// ── GitHub URL normalization (HTTPS ⇄ SSH) ────────────────────────────────────
test('parseGitHubUrl + normalizeGitHubUrl: HTTPS and SSH both normalize to a canonical pair', () => {
  const fromHttps = parseGitHubUrl('https://github.com/Acme/Repo.git');
  assert.deepEqual(fromHttps, { owner: 'Acme', repo: 'Repo', ssh: 'git@github.com:Acme/Repo.git', https: 'https://github.com/Acme/Repo.git' });
  const fromScp = parseGitHubUrl('git@github.com:Acme/Repo.git');
  assert.deepEqual(fromScp, fromHttps);
  assert.deepEqual(parseGitHubUrl('ssh://git@github.com/Acme/Repo'), fromHttps);

  assert.equal(normalizeGitHubUrl('https://github.com/Acme/Repo', 'ssh'), 'git@github.com:Acme/Repo.git');
  assert.equal(normalizeGitHubUrl('git@github.com:Acme/Repo.git', 'https'), 'https://github.com/Acme/Repo.git');
  // non-GitHub URLs pass through unchanged
  assert.equal(normalizeGitHubUrl('https://dev.azure.com/o/p/_git/r'), 'https://dev.azure.com/o/p/_git/r');
  assert.equal(parseGitHubUrl('https://gitlab.com/u/r.git'), null);
});

// ── Mode inference + resolution ───────────────────────────────────────────────
test('inferMode + resolveMode: explicit wins; GitHub⇒C; Azure⇒A(rewrite)/B(mirror)', () => {
  assert.equal(inferMode({ sourceKind: 'github', hasRewrite: false }), 'c');
  assert.equal(inferMode({ sourceKind: 'github', hasRewrite: true }), 'c');
  assert.equal(inferMode({ sourceKind: 'azure', hasRewrite: true }), 'a');
  assert.equal(inferMode({ sourceKind: 'azure', hasRewrite: false }), 'b');

  assert.equal(resolveMode({ mode: 'b', source: 'git@github.com:u/r.git', hasRewrite: true }), 'b', 'explicit overrides inference');
  assert.equal(resolveMode({ source: 'git@github.com:u/r.git', hasRewrite: true }), 'c');
  assert.equal(resolveMode({ source: 'https://dev.azure.com/o/p/_git/r', hasRewrite: true }), 'a');
  assert.equal(resolveMode({ source: 'https://dev.azure.com/o/p/_git/r', hasRewrite: false }), 'b');
});

// ── 0-commit auto-fallback decision ───────────────────────────────────────────
test('decideRewriteStrategy: rewrite with matches stays; 0 matches ⇒ mirror fallback; mirror stays', () => {
  assert.deepEqual(decideRewriteStrategy({ baseStrategy: 'rewrite', applicableCommits: 5 }), { strategy: 'rewrite', fallback: false });
  const fb = decideRewriteStrategy({ baseStrategy: 'rewrite', applicableCommits: 0 });
  assert.equal(fb.strategy, 'mirror');
  assert.equal(fb.fallback, true);
  assert.match(fb.reason, /0 commits/);
  assert.deepEqual(decideRewriteStrategy({ baseStrategy: 'mirror', applicableCommits: 0 }), { strategy: 'mirror', fallback: false });
});

// ── Integrity comparison ──────────────────────────────────────────────────────
test('diffRefs: classifies missing, extra, and tip-OID mismatches', () => {
  const a = { 'refs/heads/main': 'aaa', 'refs/heads/dev': 'bbb', 'refs/tags/v1': 'ttt' };
  const b = { 'refs/heads/main': 'aaa', 'refs/heads/dev': 'XXX', 'refs/heads/extra': 'zzz' };
  const d = diffRefs(a, b);
  assert.deepEqual(d.missing, ['refs/tags/v1']);
  assert.deepEqual(d.extra, ['refs/heads/extra']);
  assert.deepEqual(d.mismatched, [{ ref: 'refs/heads/dev', a: 'bbb', b: 'XXX' }]);
  assert.equal(d.refSetOk, false);
});

test('compareIntegrity: ok only when every migrated ref tip matches and counts agree', () => {
  const refs = { 'refs/heads/main': 'aaa', 'refs/tags/v1': 'ttt' };
  const good = compareIntegrity({ aRefs: refs, bRefs: { ...refs }, aCount: 10, bCount: 10 });
  assert.equal(good.ok, true);
  assert.match(formatIntegrityReport(good), /Integrity OK/);

  // Tip mismatch fails even when the count happens to match.
  const tip = compareIntegrity({ aRefs: refs, bRefs: { ...refs, 'refs/heads/main': 'bbb' }, aCount: 10, bCount: 10 });
  assert.equal(tip.ok, false);
  assert.match(formatIntegrityReport(tip), /ref tip differs/);

  // Count mismatch fails.
  const cnt = compareIntegrity({ aRefs: refs, bRefs: { ...refs }, aCount: 10, bCount: 9 });
  assert.equal(cnt.ok, false);
  assert.match(formatIntegrityReport(cnt), /commit count differs/);

  // A pre-existing destination-only ref is reported but does not by itself fail.
  const extra = compareIntegrity({ aRefs: refs, bRefs: { ...refs, 'refs/heads/gh-pages': 'ppp' }, aCount: 10, bCount: 10 });
  assert.equal(extra.ok, true);
  assert.deepEqual(extra.extra, ['refs/heads/gh-pages']);
});
