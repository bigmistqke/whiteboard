// Where things are, for the pages: a page's id ↔ its file ↔ its address, its source with its
// frontmatter (parsed here, once), the folders of pages, and the address of a file a page links
// to. The server serves a project through one (servedSite); `whiteboard build` writes one out (see
// build.ts), with ids, files and addresses of its own.
import fs from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { Project } from './config.ts'
import type { PageSource, PagesSource, StoredPage } from './define.ts'

/** Folders never shown or served: what a repository keeps for its tools. */
export const SKIP_DIRS = new Set(['node_modules', '.git'])

/** A page's frontmatter: YAML between `---` lines, at the very start. */
export const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/

/** Is `file` the folder `dir` or inside it? */
export const within = (file: string, dir: string) => file === dir || file.startsWith(dir + path.sep)

/** Resolve a path inside a base folder, refusing anything that escapes it. */
export function inside(base: string, rel: string): string | null {
  const p = path.resolve(base, '.' + path.posix.normalize('/' + rel))
  return within(p, base) ? p : null
}

/** A page's frontmatter, parsed as YAML; empty, with the reason, when it isn't fields. */
export function parseFrontmatter(source: string): { data: Record<string, unknown>; error: string | null } {
  const m = FRONTMATTER.exec(source)
  if (!m) return { data: {}, error: null }
  let data: unknown
  try {
    data = parseYaml(m[1]!)
  } catch (err) {
    return { data: {}, error: (err as Error).message }
  }
  if (data == null) return { data: {}, error: null }
  if (typeof data !== 'object' || Array.isArray(data))
    return { data: {}, error: 'it must be fields (`key: value` lines), not a single value or a list' }
  return { data: data as Record<string, unknown>, error: null }
}

/** A markdown file as a page: its source, the body after its frontmatter, and the frontmatter parsed. */
export function pageSource(id: string, file: string): PageSource {
  const source = fs.readFileSync(file, 'utf8')
  const { data, error } = parseFrontmatter(source)
  return {
    kind: 'page',
    id,
    file,
    mtime: fs.statSync(file).mtimeMs,
    source,
    body: source.replace(FRONTMATTER, ''),
    frontmatter: data,
    frontmatterError: error,
  }
}

/** Text files show as files; anything with a NUL byte near the start is binary. */
function isText(file: string): boolean {
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.alloc(8192)
  const n = fs.readSync(fd, buf, 0, buf.length, 0)
  fs.closeSync(fd)
  return !buf.subarray(0, n).includes(0)
}

/** A repository file's id: `-/` and its path in the project (`-` for the project's folder). */
export const isRepoId = (id: string) => id === '-' || id.startsWith('-/')

/** A project as the server serves it: its pages under its base, its files under `-/` when it serves them. */
export interface ServedSite {
  /**
   * A page id → the stored page, or { raw: file } (serve the bytes), or null (nothing there). A
   * folder of pages without an index lists its pages; a repository folder lists its entries.
   */
  page(id: string): StoredPage | { raw: string } | null
  /** The pages in a folder of the pages folder, newest first (what waits on each is the status's). */
  pagesIn(dir: string): PagesSource['pages']
  /** The address that serves a file or folder on disk, or null when nothing here serves it. */
  urlOf(file: string): string | null
  /** For links: the target if it exists (also with .md added), as its address. */
  urlFor(file: string): string | null
}

/**
 * The project as its server serves it, below `base`. `files()` says whether it serves the project's
 * own files (`-/…`), which the config can change while it runs.
 */
export function servedSite(project: Project, { base, files }: { base: string; files: () => boolean }): ServedSite {
  function pagesIn(dir: string): PagesSource['pages'] {
    const out: PagesSource['pages'] = []
    const walk = (d: string) => {
      if (!fs.existsSync(d)) return
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        if (ent.name.startsWith('.') || ent.name === 'node_modules') continue
        const full = path.join(d, ent.name)
        if (ent.isDirectory()) walk(full)
        else if (ent.name.endsWith('.md')) {
          const id = path.relative(project.pagesDir, full).split(path.sep).join('/').replace(/\.md$/, '')
          out.push({ id, file: full, mtime: fs.statSync(full).mtimeMs, lastEvent: null, awaiting: 0 })
        }
      }
    }
    walk(dir)
    return out.sort((a, b) => b.mtime - a.mtime)
  }

  function page(id: string): StoredPage | { raw: string } | null {
    if (!id) return { kind: 'pages', id: '', file: project.pagesDir, mtime: null, pages: pagesIn(project.pagesDir) }
    if (isRepoId(id)) {
      const target = inside(project.dir, id.slice(2))
      if (!target || path.relative(project.dir, target).split(path.sep).includes('.git') || !fs.existsSync(target))
        return null
      const stat = fs.statSync(target)
      if (stat.isDirectory()) {
        const entries = fs
          .readdirSync(target, { withFileTypes: true })
          .filter(e => !SKIP_DIRS.has(e.name) && e.name !== '.DS_Store')
          .map(e => ({ name: e.name, dir: e.isDirectory() }))
          .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
        return { kind: 'folder', id, file: target, mtime: stat.mtimeMs, entries }
      }
      if (/\.(md|markdown)$/i.test(target)) return pageSource(id, target)
      if (stat.size > 1e6 || !isText(target)) return { raw: target }
      return { kind: 'file', id, file: target, mtime: stat.mtimeMs, source: fs.readFileSync(target, 'utf8') }
    }
    const target = inside(project.pagesDir, id)
    if (!target) return null
    if (path.extname(id) && fs.existsSync(target) && fs.statSync(target).isFile()) return { raw: target }
    const file = target + '.md'
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      const index = path.join(target, 'index.md')
      if (fs.existsSync(index)) return pageSource(id, index)
      // a folder next to the page of its name (its screenshots, say) leaves the page its address;
      // the files in it are still served at theirs
      if (fs.existsSync(file)) return pageSource(id, file)
      return { kind: 'pages', id, file: target, mtime: null, pages: pagesIn(target) }
    }
    return fs.existsSync(file) ? pageSource(id, file) : null
  }

  function urlOf(abs: string): string | null {
    const rel = (dir: string) => path.relative(dir, abs).split(path.sep).map(encodeURIComponent).join('/')
    if (within(abs, project.pagesDir)) return `${base}/${rel(project.pagesDir).replace(/\.md$/, '')}`
    if (files() && within(abs, project.dir)) {
      if (
        rel(project.dir)
          .split('/')
          .some(part => SKIP_DIRS.has(part))
      )
        return null
      return `${base}/-/${rel(project.dir)}`
    }
    return null
  }

  function urlFor(abs: string): string | null {
    for (const candidate of [abs, abs + '.md']) {
      if (fs.existsSync(candidate)) {
        const url = urlOf(candidate)
        if (url) return url + (fs.statSync(candidate).isDirectory() && !url.endsWith('/') ? '/' : '')
      }
    }
    return null
  }

  return { page, pagesIn, urlOf, urlFor }
}
