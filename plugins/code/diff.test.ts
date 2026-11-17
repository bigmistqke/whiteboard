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
  assert.deepEqual(lines.map(l => l.kind), ['meta', 'meta', 'meta', 'meta', 'hunk', 'context', 'del', 'add', 'add', 'meta', 'meta', 'meta', 'meta', 'meta', 'hunk', 'del'])
  assert.deepEqual(lines.filter(l => l.at).map(l => l.at), ['src/a.ts:3', 'src/a.ts (old):4', 'src/a.ts:4', 'src/a.ts:5', 'gone.ts (old):1'])
})

test('diff lines: a diff without file headers has kinds but no places', () => {
  const lines = diffLines('@@ -1 +1 @@\n-a\n+b')
  assert.deepEqual(lines, [{ kind: 'hunk' }, { kind: 'del' }, { kind: 'add' }])
})
