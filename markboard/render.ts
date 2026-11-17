// markboard on the server: a stored page → the HTML the reader sees. Markdown goes through remark with
// directives and fences handed to templates (markdown.ts); repository files show as highlighted
// code, folders as listings with their README on top; around all of it goes markboard's frame.
// What markboard draws itself is built with `html` (src/html.js), which escapes every value.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { renderMarkdown, type Island, type MdNode } from './markdown.ts'
import { html, raw, type Html } from '../src/html.ts'
import type { RenderContext, Rendered, StoredPage } from '../src/define.ts'
import type { ResolvedTemplate, ResolvedTemplates } from './templates.ts'

type PagesPage = Extract<StoredPage, { kind: 'pages' }>
type FolderPage = Extract<StoredPage, { kind: 'folder' }>
interface Content { html: string | Html; title?: string | null; islands: Record<string, Island>; styles: string[] }

const BASE_CSS = new URL('./client/base.css', import.meta.url)

// before the stylesheets, so the page never flashes the wrong theme. A plain string, not part of an
// `html` template: the bundler writes `</script` in strings as `<\/script`, which in a tagged
// template would change the raw text the tag gets, so it rewrites the template into a helper call
const THEME_SCRIPT = raw(`<script>try{const t=localStorage.getItem('wb-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch{}</script>`)

const CODE_LANG: Record<string, string> = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'tsx', jsx: 'jsx', json: 'json', css: 'css', html: 'html', sh: 'bash', zsh: 'bash', py: 'python', rs: 'rust', go: 'go', toml: 'toml', yml: 'yaml', yaml: 'yaml' }

/** Frontmatter is the core's (it picks the renderer); the page starts after it. */
const body = (source: string) => source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')

/** A page's title: its first heading, else its name. */
function titleOf(file: string, fallback: string) {
  try {
    const h1 = /^#\s+(.+)$/m.exec(body(fs.readFileSync(file, 'utf8')))
    return h1 ? h1[1].replace(/[*_`]/g, '') : fallback
  } catch { return fallback }
}

function crumbs(id: string, name: string) {
  const parts = id ? id.split('/') : []
  return html`<a href="/">${name}</a>${parts.map((p, i) => html` / <a href="/${parts.slice(0, i + 1).join('/')}">${p}</a>`)}`
}

const time = (ts: number) => html`<time data-ts="${ts}"></time>`

function pageList(pages: PagesPage['pages']) {
  return html`<ul class="wb-index">${pages.map(p => html`<li><a href="/${p.id}">${titleOf(p.file, path.basename(p.id))}</a> <span class="wb-meta"><code>${p.id}</code> · edited ${time(p.mtime)}${
    p.lastEvent && html` · last submit ${time(Date.parse(p.lastEvent))}`}${
    p.listeners > 0 && html` · <span class="wb-waiting">agent waiting</span>`}</span></li>`)}</ul>`
}

/** The folder's README, when it has one. */
function readmeOf(page: FolderPage) {
  const name = ['README.md', 'readme.md', 'Readme.md'].find(n => page.entries.some(e => !e.dir && e.name === n))
  if (!name) return null
  const file = path.join(page.file, name)
  return { file, source: fs.readFileSync(file, 'utf8') }
}

/** A stylesheet reference (URL, file: URL string, or absolute path) → absolute path. */
function stylePath(ref: URL | string | undefined) {
  if (ref == null) return null
  const file = ref instanceof URL || String(ref).startsWith('file:') ? fileURLToPath(ref) : String(ref)
  if (!path.isAbsolute(file)) throw new Error(`markboard({ style }): use a URL, e.g. new URL('./style.css', import.meta.url)`)
  if (!fs.existsSync(file)) throw new Error(`markboard({ style }): file not found: ${file}`)
  return file
}

const SKIP = new Set(['node_modules', '.git', '.whiteboard', 'dist', 'build'])
const MARKDOWN = /\.(md|markdown)$/i

/**
 * Every markdown file in the project, which markboard renders as a page: the top folder's first,
 * then by path. In a git repository, the files git knows (tracked, or new and not ignored), so
 * built copies and dependencies stay out; elsewhere a walk that skips the usual build and
 * dependency folders. The project's own pages (.whiteboard/) are listed apart.
 */
function documentsIn(dir: string) {
  let files: string[]
  try {
    files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', ':(icase)*.md', ':(icase)*.markdown'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').filter(f => f && !f.startsWith('.whiteboard/') && fs.existsSync(path.join(dir, f)))
  } catch {
    files = []
    const walk = (rel: string) => {
      let entries: fs.Dirent[] = []
      try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith('.')) walk(path.posix.join(rel, e.name)) }
        else if (MARKDOWN.test(e.name)) files.push(path.posix.join(rel, e.name))
      }
    }
    walk('')
  }
  const depth = (f: string) => f.split('/').length
  return [...new Set(files)].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
}

/** The overview's list of the project's documents: each by its title, linked to its rendered page. */
function documentList(ctx: RenderContext) {
  const files = documentsIn(ctx.project.dir)
  if (!files.length) return ''
  const rows = files.map(f => {
    const abs = path.join(ctx.project.dir, f)
    return html`<li><a href="${ctx.urlFor(abs) ?? `/-/${f}`}">${titleOf(abs, f)}</a> <span class="wb-meta"><code>${f}</code></span></li>`
  })
  // in a section, so the heading isn't numbered like the page's own sections
  return html`<section class="wb-documents"><h2>Documents</h2><ul class="wb-index">${rows}</ul></section>`
}

export function createRender(templates: () => ResolvedTemplates, style?: URL | string) {
  const STYLE = stylePath(style)
  async function markdown(source: string, page: string, file: string, ctx: RenderContext) {
    const { templates: set, code } = templates()
    return renderMarkdown(body(source), { page, file, resolve: name => set.get(name) ?? null, code, linkFor: ctx.urlFor })
  }

  async function content(page: StoredPage, ctx: RenderContext): Promise<Content> {
    const { project } = ctx
    switch (page.kind) {
      case 'page':
        return markdown(page.source, page.id, page.file, ctx)
      case 'pages': {
        const list = page.pages.length ? pageList(page.pages) : html`<p class="wb-meta">No pages yet.</p>`
        const view = page.id
          ? html`<h1>${page.id}</h1>${list}<p class="wb-meta">${page.file}</p>`
          : html`<h1>${project.name}</h1>${list}${project.files && documentList(ctx)}<p class="wb-meta"><code>${project.dir}</code>${project.files && html` · <a href="/-/">files</a>`} · <a href="/_/docs">templates</a></p>`
        return { html: view, title: page.id || project.name, islands: {}, styles: [] }
      }
      case 'folder': {
        const rel = page.id.slice(2)
        const rows = page.entries.map(e => html`<li><a href="${encodeURIComponent(e.name) + (e.dir ? '/' : '')}">${e.name + (e.dir ? '/' : '')}</a></li>`)
        const listing = html`<h1>${rel || project.name}</h1><ul class="wb-files">${rel && html`<li><a href="../">../</a></li>`}${rows}</ul><p class="wb-meta">${page.file} · <code>${page.id}</code></p>`
        const readme = readmeOf(page)
        if (!readme) return { html: listing, title: rel || project.name, islands: {}, styles: [] }
        // markdown's output is HTML already
        const r = await markdown(readme.source, page.id, readme.file, ctx)
        return { ...r, html: html`${raw(r.html)}<hr>${listing}` }
      }
      case 'file': {
        // the file as one code block, rendered by the code template (or as plain code)
        const { code } = templates()
        const ext = path.extname(page.file).slice(1).toLowerCase()
        const tree: MdNode = { type: 'root', children: [{ type: 'code', lang: CODE_LANG[ext] ?? (ext || null), meta: null, value: page.source }] }
        const out = await renderMarkdown(tree, { page: page.id, file: page.file, resolve: () => null, code, linkFor: ctx.urlFor })
        const view = html`<h1 class="wb-code-title wb-wide">${page.id.slice(2)}</h1><div class="wb-code wb-wide">${raw(out.html)}</div>`
        return { html: view, title: path.basename(page.file), islands: out.islands, styles: out.styles }
      }
    }
  }

  return async function render(page: StoredPage, ctx: RenderContext): Promise<Rendered> {
    let out: Content
    try {
      out = await content(page, ctx)
    } catch (err) {
      // a template set that does not resolve (a bad entry in markboard({ templates }))
      out = { html: html`<pre class="wb-error">${(err as Error).message}</pre>`, islands: {}, styles: [] }
    }
    const islands = Object.fromEntries(Object.entries(out.islands).map(([id, island]) => [id, { ...island, client: ctx.asset(island.client) }]))
    const styles = out.styles.map(s => ctx.asset(s))
    const nav = html`<nav class="wb-nav"><span>${crumbs(page.id, ctx.project.name)}</span>${page.mtime != null && html`<span class="wb-meta">updated <time id="wb-updated" data-ts="${page.mtime}"></time></span>`}<button type="button" class="wb-theme" title="Theme: follow the system, light or dark">auto</button><span class="wb-live" title="live reload"></span></nav>`
    const links = [ctx.asset(BASE_CSS), ...styles, ...(STYLE ? [ctx.asset(STYLE)] : [])]
    return {
      title: out.title || page.id || ctx.project.name,
      head: html`${THEME_SCRIPT}
${links.map(href => html`<link rel="stylesheet" href="${href}">`)}`,
      // the page's content is HTML already: markdown's output, or what was built above
      html: html`${nav}<main id="wb-main">${raw(out.html)}</main>`,
      // the client mounts `islands` and links `styles`
      data: { islands, styles, mtime: page.mtime },
    }
  }
}

/** The syntax of every template, from their readmes: what `whiteboard docs` prints. */
export function createDocs(templates: () => ResolvedTemplates) {
  return function docs(ctx: RenderContext) {
    const all = [...templates().templates.values()]
    // templates that share a readme are documented together, under the first of them (a form and its inputs)
    const groups = new Map<string, ResolvedTemplate[]>()
    for (const t of all) {
      const key = t.readme ?? `\0${t.name}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(t)
    }
    const list = [...groups.values()].map(g => g[0]).sort((a, b) => a.name.localeCompare(b.name))
    const parts = list.map(t => {
      const what = [t.code && 'code blocks', t.client && 'client', t.html && 'html', t.props && 'props'].filter(Boolean).join(' · ')
      const also = groups.get(t.readme ?? `\0${t.name}`)!.slice(1).map(o => o.name)
      const where = html`<p class="wb-meta">from <code>${t.source}</code>${what && ` · ${what}`}${also.length ? html` · with ${also.map((n, i) => html`${i ? ', ' : ''}<code>${n}</code>`)}` : ''}</p>`
      const readme = t.readme ? fs.readFileSync(t.readme, 'utf8') : `# ${t.name}\n\n_No readme._\n`
      return readme.replace(/^(#\s.*)$/m, `$1\n\n${where}\n`)
    })
    const intro = `# Templates\n\nThe markboard renderer: markdown, with these templates in this project (${ctx.project.name}): ${list.map(t => `[${t.name}](#${t.name})`).join(' · ')}\n\nPlain markdown, GFM tables, \`<details>\` and raw HTML \`<form name="…">\` work without templates.\n\n---\n\n`
    return intro + parts.join('\n\n---\n\n')
  }
}
