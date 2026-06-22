// Unit tests for the v2 case-insensitive branch-conflict detector and resolver
// (pure logic — no IO), plus the Windows case-sensitivity attempt (injected).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isCaseOnlyConflict, isDirFileConflict, detectBranchConflicts,
  planBranchRenames, planConflictResolution,
} from '../src/team.js';
import { enableCaseSensitivity } from '../src/pipeline.js';

// ── Conflict predicates ──────────────────────────────────────────────────────
test('isCaseOnlyConflict: only when names differ solely by case', () => {
  assert.equal(isCaseOnlyConflict('Mbouzine', 'MBouzine'), true);
  assert.equal(isCaseOnlyConflict('main', 'MAIN'), true);
  assert.equal(isCaseOnlyConflict('main', 'main'), false);     // identical
  assert.equal(isCaseOnlyConflict('main', 'develop'), false);  // unrelated
});

test('isDirFileConflict: only when one ref is a strict path-prefix of the other (case-insensitive)', () => {
  assert.equal(isDirFileConflict('MBouzine', 'MBouzine/init_repo'), true);
  assert.equal(isDirFileConflict('foo', 'foo/bar'), true);
  assert.equal(isDirFileConflict('Mbouzine', 'MBouzine/init_repo'), true); // case-insensitive prefix
  assert.equal(isDirFileConflict('foo/bar', 'foo/baz'), false);            // same depth, siblings
  assert.equal(isDirFileConflict('foo', 'foobar'), false);                 // not a path segment
  assert.equal(isDirFileConflict('foo', 'foo'), false);                    // identical
});

// ── Detection ────────────────────────────────────────────────────────────────
test('detectBranchConflicts: classifies case-only and directory/file collisions; clean set is empty', () => {
  assert.deepEqual(detectBranchConflicts(['main', 'develop', 'feature/x']), []);
  assert.deepEqual(detectBranchConflicts(['Mbouzine', 'MBouzine']),
    [{ type: 'case', a: 'Mbouzine', b: 'MBouzine' }]);
  assert.deepEqual(detectBranchConflicts(['MBouzine', 'MBouzine/init_repo']),
    [{ type: 'dir-file', a: 'MBouzine', b: 'MBouzine/init_repo' }]);
  // the reported real-world case is a directory/file conflict (prefix differs only by case)
  assert.deepEqual(detectBranchConflicts(['Mbouzine', 'MBouzine/init_repo']),
    [{ type: 'dir-file', a: 'Mbouzine', b: 'MBouzine/init_repo' }]);
});

// ── Rename planning ──────────────────────────────────────────────────────────
test('planBranchRenames: renames each conflicting branch and leaves a conflict-free set', () => {
  const r = planBranchRenames(['Mbouzine', 'MBouzine']);
  assert.equal(r.renames.length, 1);
  assert.match(r.renames[0].to, /-\d+$/, 'safe -N suffix');
  assert.equal(detectBranchConflicts(r.result).length, 0, 'no conflicts remain');

  // D/F: renaming the deeper ref cannot remove the prefix relationship, so the
  // SHALLOWER (prefix) ref must be the one renamed.
  const df = planBranchRenames(['MBouzine', 'MBouzine/init_repo']);
  assert.deepEqual(df.renames, [{ from: 'MBouzine', to: 'MBouzine-1' }]);
  assert.equal(detectBranchConflicts(df.result).length, 0);

  // Three-way collision (case + D/F at once) still converges to zero conflicts,
  // preserving one branch per distinct ref.
  const tri = planBranchRenames(['Mbouzine', 'MBouzine', 'MBouzine/init_repo']);
  assert.equal(detectBranchConflicts(tri.result).length, 0);
  assert.equal(tri.result.length, 3, 'every branch is preserved');
});

test('planBranchRenames: a clean set is a no-op', () => {
  const r = planBranchRenames(['main', 'develop', 'feature/x']);
  assert.deepEqual(r.renames, []);
  assert.deepEqual(r.result.sort(), ['develop', 'feature/x', 'main']);
});

// ── Strategy planning ────────────────────────────────────────────────────────
test('planConflictResolution: rename preserves all branches; skip drops the victims', () => {
  const rename = planConflictResolution(['Mbouzine', 'MBouzine', 'main'], 'rename');
  assert.equal(rename.strategy, 'rename');
  assert.equal(rename.skipped.length, 0);
  assert.equal(rename.result.length, 3, 'all three branches kept');
  assert.equal(detectBranchConflicts(rename.result).length, 0);

  const skip = planConflictResolution(['Mbouzine', 'MBouzine', 'main'], 'skip');
  assert.equal(skip.strategy, 'skip');
  assert.equal(skip.renames.length, 0);
  assert.equal(skip.skipped.length, 1, 'one conflicting branch is dropped');
  assert.ok(skip.result.includes('main'));
  assert.equal(detectBranchConflicts(skip.result).length, 0);
});

// ── Windows case-sensitivity attempt (injected runner; pure decision) ─────────
test('enableCaseSensitivity: no-op off Windows; runs fsutil on win32 and reports outcome', () => {
  assert.deepEqual(enableCaseSensitivity('/x', { platform: 'darwin' }), { attempted: false, ok: false, reason: 'not-windows' });

  let seen;
  const okRun = enableCaseSensitivity('C:\\work\\repo.git', { platform: 'win32', runner: (cmd, args) => { seen = [cmd, ...args]; return 0; } });
  assert.deepEqual(okRun, { attempted: true, ok: true });
  assert.deepEqual(seen, ['fsutil', 'file', 'setCaseSensitiveInfo', 'C:\\work\\repo.git', 'enable']);

  const failRun = enableCaseSensitivity('C:\\work\\repo.git', { platform: 'win32', runner: () => 1 });
  assert.equal(failRun.attempted, true);
  assert.equal(failRun.ok, false);
});
