// Unit tests for the large-file detection/remediation logic — all pure, offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mbToBytes, formatBytes, parseLargeBlobLine, parseLargeBlobs, formatOffenders,
  defaultLargeFileAction, suggestGitignore, gitLfsAvailable, parseGH001, formatGH001Guidance,
} from '../src/largefiles.js';
import {
  validateMaxFileSize, validateOnLargeFile, coerceMaxFileMb, coerceOnLargeFile, DEFAULT_MAX_FILE_MB,
} from '../src/config.js';

// 182.19 MB in bytes (1024-based), matching GitHub's own display of the AppImage.
const MB_182_19 = Math.round(182.19 * 1024 * 1024);
const LIMIT_100 = mbToBytes(100);

test('mbToBytes: MiB-based, matches git-filter-repo / GitHub', () => {
  assert.equal(mbToBytes(1), 1048576);
  assert.equal(mbToBytes(100), 104857600);
  assert.equal(mbToBytes(0), 0);
});

test('formatBytes: 1024-based human sizes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1.00 KB');
  assert.equal(formatBytes(mbToBytes(100)), '100.00 MB');
  assert.equal(formatBytes(MB_182_19), '182.19 MB');
});

test('parseLargeBlobLine: only over-limit blobs, threshold is exclusive', () => {
  assert.equal(parseLargeBlobLine('commit abc 250 ', LIMIT_100), null, 'non-blob → null');
  assert.equal(parseLargeBlobLine('tree def 99 some/dir', LIMIT_100), null, 'tree → null');
  assert.equal(parseLargeBlobLine('blob aaa 50 small.txt', LIMIT_100), null, 'under limit → null');
  assert.equal(parseLargeBlobLine(`blob bbb ${LIMIT_100} exact.bin`, LIMIT_100), null, 'exactly at limit → null (exclusive)');
  assert.equal(parseLargeBlobLine('garbage line', LIMIT_100), null, 'unparseable → null');
  const o = parseLargeBlobLine(`blob ccc ${MB_182_19} app/Cursor.AppImage`, LIMIT_100);
  assert.deepEqual(o, { oid: 'ccc', size: MB_182_19, path: 'app/Cursor.AppImage' });
});

test('parseLargeBlobLine: blob with no path falls back to an oid label', () => {
  const o = parseLargeBlobLine(`blob deadbeefcafe ${MB_182_19}`, LIMIT_100);
  assert.equal(o.path, '(blob deadbeefca)');
});

test('parseLargeBlobs: dedups by path (keeps largest) and sorts largest-first', () => {
  const dump = [
    'commit c1 200 ',
    `blob b1 ${mbToBytes(200)} big/file.bin`,
    'blob b2 50 small.txt',
    `blob b3 ${mbToBytes(150)} big/file.bin`, // same path, smaller — dropped
    `blob b4 ${mbToBytes(300)} huge.iso`,
  ].join('\n');
  const out = parseLargeBlobs(dump, LIMIT_100);
  assert.equal(out.length, 2, 'two distinct offending paths');
  assert.equal(out[0].path, 'huge.iso', 'largest first');
  assert.equal(out[0].size, mbToBytes(300));
  assert.equal(out[1].path, 'big/file.bin');
  assert.equal(out[1].size, mbToBytes(200), 'kept the larger of the two same-path blobs');
});

test('formatOffenders: exact spec wording (singular)', () => {
  const msg = formatOffenders([{ path: 'Cursor-1.0.0-x86_64.AppImage', size: MB_182_19 }], 100);
  assert.equal(msg, "Found 1 file exceeding GitHub's 100 MB limit: Cursor-1.0.0-x86_64.AppImage (182.19 MB)");
});

test('formatOffenders: pluralizes and joins', () => {
  const msg = formatOffenders([
    { path: 'a.bin', size: mbToBytes(300) },
    { path: 'b.iso', size: mbToBytes(200) },
  ], 100);
  assert.equal(msg, "Found 2 files exceeding GitHub's 100 MB limit: a.bin (300.00 MB), b.iso (200.00 MB)");
});

test('defaultLargeFileAction: explicit flags are honored as-is', () => {
  assert.equal(defaultLargeFileAction({ requested: 'strip' }), 'strip');
  assert.equal(defaultLargeFileAction({ requested: 'lfs' }), 'lfs');
  assert.equal(defaultLargeFileAction({ requested: 'abort', hasPrompter: true }), 'abort');
  assert.equal(defaultLargeFileAction({ requested: 'STRIP' }), 'strip', 'case-insensitive');
});

test('defaultLargeFileAction: interactive prompts, non-interactive strips', () => {
  assert.equal(defaultLargeFileAction({ requested: '', hasPrompter: true }), 'prompt', 'interactive default');
  assert.equal(defaultLargeFileAction({ requested: '', hasPrompter: false }), 'strip', 'non-interactive default');
  assert.equal(defaultLargeFileAction({}), 'strip', 'no prompter → strip');
  assert.equal(defaultLargeFileAction({ requested: 'prompt', hasPrompter: true }), 'prompt');
  assert.equal(defaultLargeFileAction({ requested: 'prompt', hasPrompter: false }), 'strip', 'prompt with no TTY → strip');
});

test('suggestGitignore: unique extensions, skips dotfiles and extensionless', () => {
  const out = suggestGitignore([
    { path: 'a/b/Cursor.AppImage' },
    { path: 'x.AppImage' },
    { path: 'dir/y.bin' },
    { path: 'no-ext' },
    { path: '.env' },
  ]);
  assert.deepEqual(out.sort(), ['*.AppImage', '*.bin']);
});

test('gitLfsAvailable: reflects the version probe', () => {
  assert.equal(gitLfsAvailable({ probe: () => 'git-lfs/3.6.1' }), true);
  assert.equal(gitLfsAvailable({ probe: () => null }), false);
});

test('parseGH001: recognizes the rejection and extracts named files', () => {
  const stderr = [
    "remote: error: File Cursor-1.0.0-x86_64.AppImage is 182.19 MB; this exceeds GitHub's file size limit of 100.00 MB",
    'remote: error: GH001: Large files detected. You may want to try Git Large File Storage - https://git-lfs.github.com.',
    ' ! [remote rejected] Development -> Development (pre-receive hook declined)',
    "error: failed to push some refs to 'github.com:org/repo.git'",
  ].join('\n');
  const p = parseGH001(stderr);
  assert.equal(p.matched, true);
  assert.equal(p.files.length, 1);
  assert.deepEqual(p.files[0], { path: 'Cursor-1.0.0-x86_64.AppImage', size: '182.19 MB' });
});

test('parseGH001: unrelated errors do not match', () => {
  const p = parseGH001('fatal: Authentication failed for repo');
  assert.equal(p.matched, false);
  assert.equal(p.files.length, 0);
});

test('formatGH001Guidance: plain-language message naming the remediation flags', () => {
  const msg = formatGH001Guidance({ files: [{ path: 'big.AppImage', size: '182.19 MB' }] }, { maxFileSizeMb: 100 });
  assert.match(msg, /100 MB limit/);
  assert.match(msg, /big\.AppImage \(182\.19 MB\)/);
  assert.match(msg, /--on-large-file strip/);
  assert.match(msg, /--on-large-file lfs/);
  assert.match(msg, /--on-large-file abort/);
  assert.match(msg, /--max-file-size/);
  assert.doesNotMatch(msg, /exited with code/, 'no raw exit-code leakage');
});

test('config: validateMaxFileSize — default, parse, reject', () => {
  assert.equal(validateMaxFileSize(''), DEFAULT_MAX_FILE_MB);
  assert.equal(validateMaxFileSize(undefined), DEFAULT_MAX_FILE_MB);
  assert.equal(validateMaxFileSize('50'), 50);
  assert.throws(() => validateMaxFileSize('abc'), /positive number of MB/);
  assert.throws(() => validateMaxFileSize('-5'), /positive number of MB/);
  assert.throws(() => validateMaxFileSize('0'), /positive number of MB/);
});

test('config: validateOnLargeFile — blank, normalize, reject', () => {
  assert.equal(validateOnLargeFile(''), '');
  assert.equal(validateOnLargeFile('STRIP'), 'strip');
  assert.equal(validateOnLargeFile(' lfs '), 'lfs');
  assert.throws(() => validateOnLargeFile('nope'), /must be one of/);
});

test('config: lenient coercion never throws', () => {
  assert.equal(coerceMaxFileMb('abc'), DEFAULT_MAX_FILE_MB);
  assert.equal(coerceMaxFileMb('7'), 7);
  assert.equal(coerceMaxFileMb(-3), DEFAULT_MAX_FILE_MB);
  assert.equal(coerceOnLargeFile('bad'), '');
  assert.equal(coerceOnLargeFile('Abort'), 'abort');
});
