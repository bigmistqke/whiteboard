// markboard on the server: a stored page → the HTML the reader sees. Markdown goes through remark with
// directives and fences handed to templates (markdown.js); repository files show as highlighted
// code, folders as listings with their README on top; around all of it goes markboard's frame.
//
// What markboard draws itself is Solid, rendered to a string per request (`renderToString`): text
// and attributes are escaped by Solid, and HTML from markdown goes in through `innerHTML`, on
// purpose. Nothing here hydrates: the browser patches the page with the new HTML (morphdom), and
// template islands mount on their own.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { For, Show, type Element } from 'solid-js'
import { renderToString } from '@solidjs/web'
import type { RenderContext, Rendered, StoredPage } from '../src/define.ts'
import { renderMarkdown, esc } from './markdown.js'

type PagesPage = Extract<StoredPage, { kind: 'pages' }>
type FolderPage = Extract<StoredPage, { kind: 'folder' }>
type Templates = () => { templates: Map<string, any>; code: any }
interface Content { html: string; title?: string | null; islands: Record<string, any>; styles: string[] }

const BASE_CSS = new URL('./client/base.css', import.meta.url)

const CODE_LANG: Record<string, string> = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'tsx', jsx: 'jsx', json: 'json', css: 'css', html: 'html', sh: 'bash', zsh: 'bash', py: 'python', rs: 'rust', go: 'go', toml: 'toml', yml: 'yaml', yaml: 'yaml' }

// before the stylesheets, so the page never flashes the wrong theme
const THEME_SCRIPT = `try{const t=localStorage.getItem('wb-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch{}`

/** Frontmatter is the core's (it picks the renderer); the page starts after it. */
const body = (source: string) => source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')

/** HTML for a piece markboard draws. */
const html = (view: () => Element) => renderToString(view)

/** A page's title: its first heading, else its name. */
function titleOf(file: string, fallback: string) {
  try {
    const h1 = /^#\s+(.+)$/m.exec(body(fs.readFileSync(file, 'utf8')))
    return h1 ? h1[1].replace(/[*_`]/g, '') : fallback
  } catch { return fallback }
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

// ---- what markboard draws ----------------------------------------------------------------------

/** A moment, written out in the browser (relative, and kept current). */
const Time = (props: { ts: number; id?: string }) => <time id={props.id} data-ts={props.ts} />

/** The path to a page, each part a link. */
function Crumbs(props: { id: string; name: string }) {
  const parts = props.id ? props.id.split('/') : []
  return (
    <span>
      <a href="/">{props.name}</a>
      <For each={parts}>{(part, i) => <> / <a href={'/' + parts.slice(0, i() + 1).join('/')}>{part}</a></>}</For>
    </span>
  )
}

/** The bar above every page: where it is, when it changed, the theme toggle, the live indicator. */
function Nav(props: { page: StoredPage; name: string }) {
  return (
    <nav class="wb-nav">
      <Crumbs id={props.page.id} name={props.name} />
      <Show when={props.page.mtime}>{mtime => <span class="wb-meta">updated <Time id="wb-updated" ts={mtime()} /></span>}</Show>
      <button type="button" class="wb-theme" title="Theme: follow the system, light or dark">auto</button>
      <span class="wb-live" title="live reload" />
    </nav>
  )
}

/** The pages in a folder of pages: each by its title, with when it changed and was answered. */
function PageList(props: { pages: PagesPage['pages'] }) {
  return (
    <Show when={props.pages.length} fallback={<p class="wb-meta">No pages yet.</p>}>
      <ul class="wb-index">
        <For each={props.pages}>{p => (
          <li>
            <a href={`/${p.id}`}>{titleOf(p.file, path.basename(p.id))}</a>{' '}
            <span class="wb-meta">
              <code>{p.id}</code> · edited <Time ts={p.mtime} />
              <Show when={p.lastEvent}>{last => <> · last submit <Time ts={Date.parse(last())} /></>}</Show>
              <Show when={p.listeners}> · <span class="wb-waiting">agent waiting</span></Show>
            </span>
          </li>
        )}</For>
      </ul>
    </Show>
  )
}

/** The project's markdown documents: each by its title, linked to its rendered page. */
function DocumentList(props: { ctx: RenderContext }) {
  const files = documentsIn(props.ctx.project.dir)
  return (
    <Show when={files.length}>
      {/* in a section, so the heading isn't numbered like the page's own sections */}
      <section class="wb-documents">
        <h2>Documents</h2>
        <ul class="wb-index">
          <For each={files}>{f => {
            const abs = path.join(props.ctx.project.dir, f)
            return (
              <li>
                <a href={props.ctx.urlFor(abs) ?? `/-/${f}`}>{titleOf(abs, f)}</a>{' '}
                <span class="wb-meta"><code>{f}</code></span>
              </li>
            )
          }}</For>
        </ul>
      </section>
    </Show>
  )
}

/** The overview (`/`) or a folder of pages without an index.md. */
function Pages(props: { page: PagesPage; ctx: RenderContext }) {
  const { project } = props.ctx
  return (
    <Show
      when={props.page.id}
      fallback={<>
        <h1>{project.name}</h1>
        <PageList pages={props.page.pages} />
        <Show when={project.files}><DocumentList ctx={props.ctx} /></Show>
        <p class="wb-meta">
          <code>{project.dir}</code>
          <Show when={project.files}> · <a href="/-/">files</a></Show> · <a href="/_/docs">templates</a>
        </p>
      </>}
    >
      <h1>{props.page.id}</h1>
      <PageList pages={props.page.pages} />
      <p class="wb-meta">{props.page.file}</p>
    </Show>
  )
}

/** A repository folder: its entries, one link each. */
function Folder(props: { page: FolderPage; name: string }) {
  const rel = props.page.id.slice(2)
  return (
    <>
      <h1>{rel || props.name}</h1>
      <ul class="wb-files">
        <Show when={rel}><li><a href="../">../</a></li></Show>
        <For each={props.page.entries}>{e => {
          const name = e.name + (e.dir ? '/' : '')
          return <li><a href={encodeURIComponent(e.name) + (e.dir ? '/' : '')}>{name}</a></li>
        }}</For>
      </ul>
      <p class="wb-meta">{props.page.file} · <code>{props.page.id}</code></p>
    </>
  )
}

/** markboard's additions to the page's <head>: the theme, its own styles and the templates'. */
function Head(props: { styles: string[] }) {
  return (
    <>
      <script innerHTML={THEME_SCRIPT} />
      <For each={props.styles}>{href => <link rel="stylesheet" href={href} />}</For>
    </>
  )
}

// ---- rendering ---------------------------------------------------------------------------------

export function createRender(templates: Templates, style?: URL | string) {
  const STYLE = stylePath(style)
  async function markdown(source: string, page: string, file: string, ctx: RenderContext) {
    const { templates: set, code } = templates()
    return renderMarkdown(body(source), { page, file, resolve: (name: string) => set.get(name) ?? null, code, linkFor: ctx.urlFor })
  }

  async function content(page: StoredPage, ctx: RenderContext): Promise<Content> {
    const { project } = ctx
    switch (page.kind) {
      case 'page':
        return markdown(page.source, page.id, page.file, ctx)
      case 'pages':
        return { html: html(() => <Pages page={page} ctx={ctx} />), title: page.id || project.name, islands: {}, styles: [] }
      case 'folder': {
        const listing = html(() => <Folder page={page} name={project.name} />)
        const readme = readmeOf(page)
        if (!readme) return { html: listing, title: page.id.slice(2) || project.name, islands: {}, styles: [] }
        // the README's blocks and the listing's stay siblings in the page: new-content marks
        // compare the page's top-level blocks
        const r = await markdown(readme.source, page.id, readme.file, ctx)
        return { ...r, html: `${r.html}<hr>${listing}` }
      }
      case 'file': {
        // the file as one code block, rendered by the code template (or as plain code)
        const { code } = templates()
        const ext = path.extname(page.file).slice(1).toLowerCase()
        const tree = { type: 'root', children: [{ type: 'code', lang: CODE_LANG[ext] ?? (ext || null), meta: null, value: page.source }] }
        const out = await renderMarkdown(tree, { page: page.id, file: page.file, resolve: () => null, code, linkFor: ctx.urlFor })
        const view = html(() => <>
          <h1 class="wb-code-title wb-wide">{page.id.slice(2)}</h1>
          <div class="wb-code wb-wide" innerHTML={out.html} />
        </>)
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
      out = { html: html(() => <pre class="wb-error">{(err as Error).message}</pre>), islands: {}, styles: [] }
    }
    const islands = Object.fromEntries(Object.entries(out.islands).map(([id, island]) => [id, { ...island, client: ctx.asset(island.client) }]))
    const styles = out.styles.map(s => ctx.asset(s))
    const links = [ctx.asset(BASE_CSS), ...styles, ...(STYLE ? [ctx.asset(STYLE)] : [])]
    return {
      title: out.title || page.id || ctx.project.name,
      head: html(() => <Head styles={links} />),
      html: html(() => <>
        <Nav page={page} name={ctx.project.name} />
        <main id="wb-main" innerHTML={out.html} />
      </>),
      // the client mounts `islands` and links `styles`
      data: { islands, styles, mtime: page.mtime },
    }
  }
}

const COMMENTS = `## Comments

The reader can select text on any page and comment on it. Each comment comes
to you as an event on the page, like a form answer:

\`\`\`json
{"id":"…","page":"plan","type":"comment","data":{"quote":"the selected text","before":"…","after":"…","block":3,"text":"their comment"}}
\`\`\`

Replies to a thread come as \`comment-reply\` (\`data.replyTo\` is the comment's
id), and \`comment-resolve\` when the reader closed it. A thread stays on the
page until the reader closes it. Answer a comment the way it asks:

- **It asks for a change:** edit the page. The thread stays, so say what you
  changed in a reply if it is not obvious.
- **It asks a question:** reply in the thread:
  \`whiteboard append --page <file> --type comment-reply --data '{"replyTo":"<comment id>","text":"…"}'\`

Your replies show as the agent's, and \`wait\` and \`watch\` skip what you
append, so you don't hear your own replies.`

/** The syntax of every template, from their readmes: what `whiteboard docs` prints (markdown). */
export function createDocs(templates: Templates) {
  return function docs(ctx: RenderContext) {
    const list = [...templates().templates.values()].sort((a, b) => a.name.localeCompare(b.name))
    const parts = list.map(t => {
      const what = [t.code && 'code blocks', t.client && 'client', t.html && 'html', t.props && 'props'].filter(Boolean).join(' · ')
      const where = `<p class="wb-meta">from <code>${esc(t.source)}</code>${what ? ` · ${what}` : ''}</p>`
      const readme = t.readme ? fs.readFileSync(t.readme, 'utf8') : `# ${t.name}\n\n_No readme._\n`
      return readme.replace(/^(#\s.*)$/m, `$1\n\n${where}\n`)
    })
    const intro = `# Templates\n\nThe markboard renderer: markdown, with these templates in **${ctx.project.name}**: ${list.map(t => `[${t.name}](#${t.name})`).join(' · ')}\n\nPlain markdown, GFM tables, \`<details>\` and raw HTML \`<form name="…">\` work without templates.\n\n${COMMENTS}\n\n---\n\n`
    return intro + parts.join('\n\n---\n\n')
  }
}
