import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidePushStrategy } from '../src/pipeline.js';

// Ancestry oracle for a simple two-commit chain: A is the parent of B.
const chain = (a, b) => (x, y) => (x === a && y === b); // x is-ancestor-of y

test('decidePushStrategy: no local tip → missing-local', () => {
  assert.equal(decidePushStrategy({ localSha: '', remoteSha: 'B', isAncestor: () => false }), 'missing-local');
});

test('decidePushStrategy: absent remote → create', () => {
  assert.equal(decidePushStrategy({ localSha: 'A', remoteSha: '', isAncestor: () => false }), 'create');
});

test('decidePushStrategy: equal tips → noop', () => {
  assert.equal(decidePushStrategy({ localSha: 'A', remoteSha: 'A', isAncestor: () => false }), 'noop');
});

test('decidePushStrategy: remote behind local → fast-forward (safe, no force)', () => {
  // remote=A is ancestor of local=B
  assert.equal(decidePushStrategy({ localSha: 'B', remoteSha: 'A', isAncestor: chain('A', 'B') }), 'fast-forward');
});

test('decidePushStrategy: remote ahead of local → remote-ahead (never overwrite)', () => {
  // local=A is ancestor of remote=B
  assert.equal(decidePushStrategy({ localSha: 'A', remoteSha: 'B', isAncestor: chain('A', 'B') }), 'remote-ahead');
});

test('decidePushStrategy: unrelated histories → diverged', () => {
  assert.equal(decidePushStrategy({ localSha: 'X', remoteSha: 'Y', isAncestor: () => false }), 'diverged');
});
