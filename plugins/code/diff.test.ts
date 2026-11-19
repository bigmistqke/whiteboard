import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffLines } from './diff.ts'

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -3,3 +3,4 @@ function f() {
 keep
-old line
+new line
+another
\\ No newline at end of file
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-bye`

test('diff lines: kinds, and where each line in a hunk is', () => {
  const lines = diffLines(DIFF)
  assert.deepEqual(
    lines.map(l => l.kind),
    [
      'meta',
      'meta',
      'meta',
      'file',
      'hunk',
      'context',
      'del',
      'add',
      'add',
      'meta',
      'meta',
      'meta',
      'meta',
      'file',
      'hunk',
      'del',
    ],
  )
  assert.deepEqual(
    lines.filter(l => l.at).map(l => l.at),
    ['src/a.ts:3', 'src/a.ts (old):4', 'src/a.ts:4', 'src/a.ts:5', 'gone.ts (old):1'],
  )
  assert.deepEqual(
    lines.filter(l => l.n).map(l => l.n),
    [3, 4, 4, 5, 1],
  )
})

test('diff lines: what the reader sees of the headers', () => {
  const labels = diffLines(DIFF)
    .filter(l => l.label != null)
    .map(l => l.label)
  assert.deepEqual(labels, ['src/a.ts', '', 'gone.ts  (deleted)', ''])
  const renamed = diffLines(
    'diff --git a/x.ts b/y.ts\nsimilarity index 90%\nrename from x.ts\nrename to y.ts\n--- a/x.ts\n+++ b/y.ts',
  )
  assert.equal(renamed.find(l => l.kind === 'file')?.label, 'x.ts → y.ts')
})

test('diff lines: a diff without file headers has kinds and numbers, but no places', () => {
  const lines = diffLines('@@ -1 +1 @@\n-a\n+b')
  assert.deepEqual(lines, [
    { kind: 'hunk', label: '' },
    { kind: 'del', n: 1 },
    { kind: 'add', n: 1 },
  ])
})

test('diff lines: a snippet without hunks is added, removed and unchanged lines, nothing hidden', () => {
  assert.deepEqual(diffLines('function f() {\n-  return 1\n+  return 2\n}'), [
    { kind: 'context' },
    { kind: 'del' },
    { kind: 'add' },
    { kind: 'context' },
  ])
})

test('diff lines: a bare @@ starts a hunk without numbers, under a diff --git header too', () => {
  const lines = diffLines('diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@\n keep\n-old\n+new')
  assert.deepEqual(lines, [
    { kind: 'meta' },
    { kind: 'meta' },
    { kind: 'file', label: 'x.ts' },
    { kind: 'hunk', label: '' },
    { kind: 'context' },
    { kind: 'del' },
    { kind: 'add' },
  ])
})

test('diff lines: --- and +++ lines name the file without a diff --git header', () => {
  const lines = diffLines('--- a/x.ts\n+++ b/x.ts\n@@\n-old\n+new\n@@ -10 +10 @@\n-a\n+b')
  assert.deepEqual(lines, [
    { kind: 'meta' },
    { kind: 'file', label: 'x.ts' },
    { kind: 'hunk', label: '' },
    { kind: 'del' },
    { kind: 'add' },
    { kind: 'hunk', label: '' },
    { kind: 'del', n: 10, at: 'x.ts (old):10' },
    { kind: 'add', n: 10, at: 'x.ts:10' },
  ])
})

test('diff lines: a snippet removing a line that starts with -- is still a snippet', () => {
  assert.deepEqual(diffLines('--- a comment\n+// a comment'), [{ kind: 'del' }, { kind: 'add' }])
})
