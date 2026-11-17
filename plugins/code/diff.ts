// What each line of a diff fence is, for marking it: added, removed, unchanged, a hunk's header, or
// a file's header; and where it is, as `file:line` (the line in the new file; a removed line counts
// in the old one, `file (old):line`). Reads unified diffs, as `git diff` and `diff -u` print them.

export type DiffKind = 'add' | 'del' | 'context' | 'hunk' | 'meta'

export interface DiffLineInfo {
  kind: DiffKind
  /** `file:line`, for a line in a hunk of a known file */
  at?: string
}

const unprefix = (p: string) => p.replace(/\t.*$/, '').replace(/^"|"$/g, '').replace(/^[ab]\//, '')

export function diffLines(text: string): DiffLineInfo[] {
  let file = '', oldFile = '', oldN = 0, newN = 0, inHunk = false
  return text.split('\n').map((line): DiffLineInfo => {
    const at = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (at) { oldN = Number(at[1]); newN = Number(at[2]); inHunk = true; return { kind: 'hunk' } }
    if (inHunk) {
      const sign = line[0]
      const where = (side: 'old' | 'new', n: number) => (side === 'old' ? oldFile || file : file || oldFile) ? { at: side === 'old' ? `${oldFile || file} (old):${n}` : `${file || oldFile}:${n}` } : {}
      if (sign === '+') return { kind: 'add', ...where('new', newN++) }
      if (sign === '-') return { kind: 'del', ...where('old', oldN++) }
      if (sign === ' ') { oldN++; return { kind: 'context', ...where('new', newN++) } }
      // "\ No newline at end of file" belongs to the hunk; anything else ends it
      if (sign === '\\') return { kind: 'meta' }
      inHunk = false
    }
    if (line.startsWith('diff --git ')) { file = ''; oldFile = '' }
    else if (line.startsWith('--- ')) oldFile = line === '--- /dev/null' ? '' : unprefix(line.slice(4))
    else if (line.startsWith('+++ ')) file = line === '+++ /dev/null' ? '' : unprefix(line.slice(4))
    return { kind: 'meta' }
  })
}
