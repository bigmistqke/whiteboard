// A page on the server: a stored page → the HTML the reader sees. Markdown goes through remark with
// directives and fences handed to the plugins' blocks (markdown.ts); repository files show as highlighted
// code, folders as listings with their README on top; around all of it goes the page's frame.
// What the page draws itself is built with `html` (../html.ts), which escapes every value.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { renderMarkdown, type Island, type MdNode } from './markdown.ts'
import { html, raw, type Html } from '../html.ts'
import { INBOX_ICON, awaitingLabel } from '../icons.ts'
import type { Plugin, RenderContext, Rendered, StoredPage, TextLink } from '../define.ts'
import type { ResolvedBlock, ResolvedBlocks } from './blocks.ts'

type PagesPage = Extract<StoredPage, { kind: 'pages' }>
type FolderPage = Extract<StoredPage, { kind: 'folder' }>
interface Content {
  html: string | Html
  title?: string | null
  islands: Record<string, Island>
  styles: string[]
}

const BASE_CSS = new URL('../client/page/base.css', import.meta.url)

// before the stylesheets, so the page never flashes the wrong theme. A plain string, not part of an
// `html` template: the bundler writes `</script` in strings as `<\/script`, which in a tagged
// template would change the raw text the tag gets, so it rewrites the template into a helper call
const THEME_SCRIPT = raw(
  `<script>try{const t=localStorage.getItem('wb-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch{}</script>`,
)

const CODE_LANG: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'tsx',
  jsx: 'jsx',
  json: 'json',
  css: 'css',
  html: 'html',
  sh: 'bash',
  zsh: 'bash',
  py: 'python',
  rs: 'rust',
  go: 'go',
  toml: 'toml',
  yml: 'yaml',
  yaml: 'yaml',
}

/** Frontmatter is the core's; the page starts after it. */
const body = (source: string) => source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')

/** A page's title: its first heading, else its name. */
export function titleOf(file: string, fallback: string) {
  try {
    const h1 = /^#\s+(.+)$/m.exec(body(fs.readFileSync(file, 'utf8')))
    return h1 ? h1[1].replace(/[*_`]/g, '') : fallback
  } catch {
    return fallback
  }
}

function crumbs(id: string, name: string, base: string, entry?: RenderContext['entry']) {
  const parts = id ? id.split('/') : []
  // under a shared server, the index of every entry and its project come first
  const above = entry ? html`<a href="/">${entry.name}</a> / ` : ''
  return html`${above}<a href="${base}/">${name}</a
    >${parts.map((p, i) => html` / <a href="${base}/${parts.slice(0, i + 1).join('/')}">${p}</a>`)}`
}

const time = (ts: number) => html`<time data-ts="${ts}"></time>`

function pageList(pages: PagesPage['pages'], base: string) {
  return html`<ul class="wb-index">
    ${pages.map(
      p =>
        html`<li>
          <a href="${base}/${p.id}">${titleOf(p.file, path.basename(p.id))}</a>${
            p.awaiting > 0 &&
            html` <a
              class="wb-awaiting"
              href="${base}/${p.id}#wb-waiting"
              title="${awaitingLabel(p.awaiting)}"
              aria-label="${awaitingLabel(p.awaiting)}"
              >${raw(INBOX_ICON)}${p.awaiting}</a
            >`
          }
          <span class="wb-meta"
            ><code>${p.id}</code> · edited
            ${time(p.mtime)}${p.lastEvent && html` · last submit ${time(Date.parse(p.lastEvent))}`}</span
          >
        </li>`,
    )}
  </ul>`
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
  if (!path.isAbsolute(file)) throw new Error(`style: use a URL, e.g. new URL('./style.css', import.meta.url)`)
  if (!fs.existsSync(file)) throw new Error(`style: file not found: ${file}`)
  return file
}

const SKIP = new Set(['node_modules', '.git', '.whiteboard', 'dist', 'build'])
const MARKDOWN = /\.(md|markdown)$/i

/**
 * Every markdown file in the project, which renders as a page: the top folder's first,
 * then by path. In a git repository, the files git knows (tracked, or new and not ignored), so
 * built copies and dependencies stay out; elsewhere a walk that skips the usual build and
 * dependency folders. The project's own pages (.whiteboard/) are listed apart.
 */
function documentsIn(dir: string) {
  let files: string[]
  try {
    files = execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '--', ':(icase)*.md', ':(icase)*.markdown'],
      { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
      .split('\n')
      .filter(f => f && !f.startsWith('.whiteboard/') && fs.existsSync(path.join(dir, f)))
  } catch {
    files = []
    const walk = (rel: string) => {
      let entries: fs.Dirent[] = []
      try {
        entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (e.isDirectory()) {
          if (!SKIP.has(e.name) && !e.name.startsWith('.')) walk(path.posix.join(rel, e.name))
        } else if (MARKDOWN.test(e.name)) files.push(path.posix.join(rel, e.name))
      }
    }
    walk('')
  }
  const depth = (f: string) => f.split('/').length
  return [...new Set(files)].toSorted((a, b) => depth(a) - depth(b) || a.localeCompare(b))
}

/**
 * The overview's list of the project's documents: each by its title, linked to its rendered page,
 * with when its file last changed. The list can be sorted in the browser (sort.ts): by folder (as
 * written here), by when last updated, or by title; each row carries what it is sorted by.
 */
function documentList(ctx: RenderContext) {
  const files = documentsIn(ctx.project.dir)
  if (!files.length) return ''
  const rows = files.map((f, i) => {
    const abs = path.join(ctx.project.dir, f)
    // a file without a heading goes by its name, and the line under it says the folder it is in
    const name = path.posix.basename(f)
    const title = titleOf(abs, name)
    const where = title === name ? path.posix.dirname(f) : f
    let mtime = 0
    try {
      mtime = fs.statSync(abs).mtimeMs
    } catch {
      /* gone meanwhile */
    }
    return html`<li data-order="${i}" data-updated="${mtime}" data-title="${title.toLowerCase()}">
      <a href="${ctx.urlFor(abs) ?? `${ctx.base ?? ''}/-/${f}`}">${title}</a>
      <span class="wb-meta"
        >${where !== '.' && html`<code>${where === f ? f : `${where}/`}</code> · `}edited ${time(mtime)}</span
      >
    </li>`
  })
  // in a section, so the heading isn't numbered like the page's own sections
  return html`<section class="wb-documents">
    <div class="wb-list-head">
      <h2>Documents</h2>
      <label class="wb-sort"
        >sort
        <select data-wb-sort="documents" aria-label="Sort the documents">
          <option value="order">by folder</option>
          <option value="updated">last updated</option>
          <option value="title">by title</option>
        </select></label
      >
    </div>
    <ul class="wb-index">
      ${rows}
    </ul>
  </section>`
}

/** The plugins' text links for a project folder, asked once per folder. */
function textLinksOf(links: ((ctx: { dir: string }) => TextLink[])[]) {
  const linksFor = new Map<string, TextLink[]>()
  return (dir: string) => {
    let got = linksFor.get(dir)
    if (!got) {
      got = links.flatMap(fn => {
        try {
          return fn({ dir })
        } catch (err) {
          console.error('links:', err)
          return []
        }
      })
      linksFor.set(dir, got)
    }
    return got
  }
}

/**
 * A message (a comment, a chat message) as HTML: markdown as on a page, but its raw HTML as text and
 * its directives as written. Code fences go to the code block, so `styles` are what it needs linked.
 */
export function createMessageRender(
  blocks: () => ResolvedBlocks,
  links: ((ctx: { dir: string }) => TextLink[])[] = [],
) {
  const textLinks = textLinksOf(links)
  return async (text: string, ctx: RenderContext) => {
    const out = await renderMarkdown(String(text ?? ''), {
      page: '',
      file: '',
      resolve: () => null,
      code: blocks().code,
      textLinks: textLinks(ctx.project.dir),
      message: true,
    })
    return { html: out.html, styles: out.styles.map(s => ctx.asset(s)) }
  }
}

/** What a block left out of a build (RenderContext.skip) is: nothing, for its directives and fences alike. */
const skipped = (name: string): ResolvedBlock => ({
  name,
  code: false,
  fences: true,
  props: null,
  html: () => '',
  open: null,
  client: null,
  style: null,
  source: 'build',
})

export function createRender(
  blocks: () => ResolvedBlocks,
  style?: URL | string,
  pluginStyles: { plugin: string; file: URL | string }[] = [],
  links: ((ctx: { dir: string }) => TextLink[])[] = [],
  composers: Map<string, NonNullable<Plugin['compose']>> = new Map(),
) {
  const textLinks = textLinksOf(links)
  const STYLE = stylePath(style)
  const PLUGIN_STYLES = pluginStyles
    .map(s => ({ plugin: s.plugin, file: stylePath(s.file) }))
    .filter((s): s is { plugin: string; file: string } => !!s.file)
  async function markdown(source: string, page: string, file: string, ctx: RenderContext) {
    const { blocks: set, code } = blocks()
    const skip = ctx.skip
    return renderMarkdown(body(source), {
      page,
      file,
      resolve: name => {
        const block = set.get(name) ?? null
        if (skip && (skip.has(name) || (block && skip.has(block.source)))) return skipped(name)
        return block
      },
      code,
      linkFor: ctx.urlFor,
      textLinks: textLinks(ctx.project.dir),
      // a build leaves out a skipped plugin's composing too: the block as it is
      composers: skip
        ? new Map(
            [...composers].map(([name, compose]) =>
              skip.has(name) ? [name, ({ children }: { children: unknown }) => String(children)] : [name, compose],
            ),
          )
        : composers,
    })
  }

  async function content(page: StoredPage, ctx: RenderContext): Promise<Content> {
    const { project } = ctx
    switch (page.kind) {
      case 'page':
        return markdown(page.source, page.id, page.file, ctx)
      case 'pages': {
        const list = page.pages.length
          ? pageList(page.pages, ctx.base ?? '')
          : html`<p class="wb-meta">No pages yet.</p>`
        const view = page.id
          ? html`<h1>${page.id}</h1>
              ${list}
              <p class="wb-meta">${page.file}</p>`
          : html`<h1>${project.name}</h1>
              ${list}${project.files && documentList(ctx)}
              <p class="wb-meta">
                <code>${project.dir}</code>${project.files && html` · <a href="${ctx.base ?? ''}/-/">files</a>`} ·
                <a href="${ctx.base ?? ''}/_/docs">how to write pages</a>
              </p>`
        return { html: view, title: page.id || project.name, islands: {}, styles: [] }
      }
      case 'folder': {
        const rel = page.id.slice(2)
        const rows = page.entries.map(
          e =>
            html`<li>
              <a href="${encodeURIComponent(e.name) + (e.dir ? '/' : '')}">${e.name + (e.dir ? '/' : '')}</a>
            </li>`,
        )
        const listing = html`<h1>${rel || project.name}</h1>
          <ul class="wb-files">
            ${rel && html`<li><a href="../">../</a></li>`}${rows}
          </ul>
          <p class="wb-meta">${page.file} · <code>${page.id}</code></p>`
        const readme = readmeOf(page)
        if (!readme) return { html: listing, title: rel || project.name, islands: {}, styles: [] }
        // markdown's output is HTML already
        const r = await markdown(readme.source, page.id, readme.file, ctx)
        return {
          ...r,
          html: html`${raw(r.html)}
            <hr />
            ${listing}`,
        }
      }
      case 'file': {
        // the file as one code block, rendered by the code block (or as plain code)
        const { code } = blocks()
        const ext = path.extname(page.file).slice(1).toLowerCase()
        const tree: MdNode = {
          type: 'root',
          children: [{ type: 'code', lang: CODE_LANG[ext] ?? (ext || null), meta: null, value: page.source }],
        }
        const out = await renderMarkdown(tree, {
          page: page.id,
          file: page.file,
          resolve: () => null,
          code,
          linkFor: ctx.urlFor,
        })
        const view = html`<h1 class="wb-code-title wb-wide">${page.id.slice(2)}</h1>
          <div class="wb-code wb-wide">${raw(out.html)}</div>`
        return { html: view, title: path.basename(page.file), islands: out.islands, styles: out.styles }
      }
    }
  }

  return async function render(page: StoredPage, ctx: RenderContext): Promise<Rendered> {
    let out: Content
    try {
      out = await content(page, ctx)
    } catch (err) {
      // blocks that do not resolve (a bad block in a plugin)
      out = { html: html`<pre class="wb-error">${(err as Error).message}</pre>`, islands: {}, styles: [] }
    }
    const islands = Object.fromEntries(
      Object.entries(out.islands).map(([id, island]) => [id, { ...island, client: ctx.asset(island.client) }]),
    )
    const styles = out.styles.map(s => ctx.asset(s))
    // a built page: the project's name and the theme; nothing of the server's (crumbs into its
    // folders, when it was updated, whether it is live)
    const nav =
      ctx.live === false
        ? html`<nav class="wb-nav">
            <span>${ctx.project.name}</span
            ><button
              type="button"
              class="wb-theme"
              title="Theme: follow the system, light or dark"
              aria-label="Theme"
            ></button>
          </nav>`
        : html`<nav class="wb-nav">
            <span>${crumbs(page.id, ctx.entry?.label || ctx.project.name, ctx.base ?? '', ctx.entry)}</span
            >${page.mtime != null && html`<span class="wb-meta">updated <time id="wb-updated" data-ts="${page.mtime}"></time></span>`}<button
              type="button"
              class="wb-theme"
              title="Theme: follow the system, light or dark"
              aria-label="Theme"
            ></button
            ><span class="wb-live" role="img" title="Connecting…" aria-label="Connecting…"></span>
          </nav>`
    // the page's own, the plugins' (every page), the blocks' on this page, then the project's
    const links = [
      ctx.asset(BASE_CSS),
      ...PLUGIN_STYLES.filter(s => !ctx.skip?.has(s.plugin)).map(s => ctx.asset(s.file)),
      ...styles,
      ...(STYLE ? [ctx.asset(STYLE)] : []),
    ]
    return {
      title: out.title || page.id || ctx.project.name,
      head: html`${THEME_SCRIPT} ${links.map(href => html`<link rel="stylesheet" href="${href}" />`)}`,
      // the page's content is HTML already: markdown's output, or what was built above
      html: html`${nav}
        <main id="wb-main">${raw(out.html)}</main>`,
      // the client mounts `islands` and links `styles`
      data: { islands, styles, mtime: page.mtime },
    }
  }
}

/**
 * What `whiteboard docs` prints first: how pages are written, and which blocks the project's plugins
 * bring. Each plugin's own docs, printed after it, say how to write its blocks.
 */
export function createDocs(blocks: () => ResolvedBlocks) {
  return function docs(_ctx: RenderContext) {
    const byPlugin = new Map<string, string[]>()
    for (const t of blocks().blocks.values())
      byPlugin.set(t.source, [
        ...(byPlugin.get(t.source) ?? []),
        t.code ? `${t.name} (every other code fence)` : t.name,
      ])
    const list = [...byPlugin]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([plugin, blocks]) => `- **${plugin}**: ${blocks.map(b => `\`${b}\``).join(', ')}`)
    return `# Pages

A page is markdown: GFM tables, \`<details>\`, raw HTML and a hand-written \`<form name="…">\` work as they are. Plugins add blocks to it: \`:::name\` around content, \`::name\` on a line, \`:name\` inside a line, and code fences (\`\`\`\` \`\`\`name \`\`\`\`). A block nobody brings renders its content, so a typo never breaks a page.

The blocks here, by the plugin that brings them (each plugin's section below says how to write them):

${list.join('\n')}
`
  }
}
