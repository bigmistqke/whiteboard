// What each line of a diff fence is, for showing it to a reader rather than a tool: added, removed,
// unchanged, a gap between hunks, a file's name, or a header line nobody needs to read (`diff --git`,
// `index`, `---`, modes), which the block leaves out. A line in a hunk has its number (`n`) and
// where it is (`at`: `file:line` in the new file; a removed line counts in the old one,
// `file (old):line`). Reads unified diffs, as `git diff` and `diff -u` print them.

export type DiffKind = 'add' | 'del' | 'context' | 'hunk' | 'file' | 'meta'

export interface DiffLineInfo {
  kind: DiffKind
  /** a line in a hunk: its number, in the new file (a removed line: in the old one) */
  n?: number
  /** `file:line`, for a line in a hunk of a known file */
  at?: string
  /** what to show instead of the line: a file's name, a hunk's start */
  label?: string
}

const unprefix = (p: string) => p.replace(/\t.*$/, '').replace(/^"|"$/g, '').replace(/^[ab]\//, '')

export function diffLines(text: string): DiffLineInfo[] {
  let file = '', oldFile = '', oldN = 0, newN = 0, inHunk = false
  let status = '', renamedFrom = ''
  return text.split('\n').map((line): DiffLineInfo => {
    const at = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (at) {
      oldN = Number(at[1]); newN = Number(at[2]); inHunk = true
      // only a mark that lines were skipped: the numbers are in the gutter, and the text git adds
      // after them is a guess at the enclosing line, often just the one before
      return { kind: 'hunk', label: '' }
    }
    if (inHunk) {
      const sign = line[0]
      const where = (side: 'old' | 'new', n: number): DiffLineInfo | {} => {
        const name = side === 'old' ? oldFile || file : file || oldFile
        return name ? { n, at: side === 'old' ? `${name} (old):${n}` : `${name}:${n}` } : { n }
      }
      if (sign === '+') return { kind: 'add', ...where('new', newN++) }
      if (sign === '-') return { kind: 'del', ...where('old', oldN++) }
      if (sign === ' ') { oldN++; return { kind: 'context', ...where('new', newN++) } }
      // "\ No newline at end of file" belongs to the hunk; anything else ends it
      if (sign === '\\') return { kind: 'meta' }
      inHunk = false
    }
    if (line.startsWith('diff --git ')) { file = ''; oldFile = ''; status = ''; renamedFrom = '' }
    else if (line.startsWith('new file mode')) status = 'new'
    else if (line.startsWith('deleted file mode')) status = 'deleted'
    else if (line.startsWith('rename from ')) renamedFrom = line.slice('rename from '.length)
    else if (line.startsWith('--- ')) oldFile = line === '--- /dev/null' ? '' : unprefix(line.slice(4))
    else if (line.startsWith('+++ ')) {
      // the file's name, once its headers are read: what the reader sees of them
      file = line === '+++ /dev/null' ? '' : unprefix(line.slice(4))
      const name = renamedFrom ? `${renamedFrom} → ${file}` : file || oldFile
      return { kind: 'file', label: status ? `${name}  (${status})` : name }
    }
    return { kind: 'meta' }
  })
}
