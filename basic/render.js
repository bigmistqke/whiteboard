// basic on the server: a stored page → the HTML the reader sees. Markdown goes through remark with
// directives and fences handed to templates (markdown.js); repository files show as highlighted
// code, folders as listings with their README on top; around all of it goes basic's frame.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderMarkdown, esc } from './markdown.js'

const BASE_CSS = new URL('./client/base.css', import.meta.url)

const CODE_LANG = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'tsx', jsx: 'jsx', json: 'json', css: 'css', html: 'html', sh: 'bash', zsh: 'bash', py: 'python', rs: 'rust', go: 'go', toml: 'toml', yml: 'yaml', yaml: 'yaml' }

/** Frontmatter is the core's (it picks the renderer); the page starts after it. */
const body = source => source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')

/** A page's title: its first heading, else its name. */
function titleOf(file, fallback) {
  try {
    const h1 = /^#\s+(.+)$/m.exec(body(fs.readFileSync(file, 'utf8')))
    return h1 ? h1[1].replace(/[*_`]/g, '') : fallback
  } catch { return fallback }
}

function crumbs(id, name) {
  let acc = ''
  return `<a href="/">${esc(name)}</a>` + (id ? id.split('/') : []).map(p => { acc += '/' + p; return ` / <a href="${esc(acc)}">${esc(p)}</a>` }).join('')
}

const time = ts => `<time data-ts="${ts}"></time>`

function pageList(pages) {
  return `<ul class="wb-index">${pages.map(p =>
    `<li><a href="/${esc(p.id)}">${esc(titleOf(p.file, path.basename(p.id)))}</a> <span class="wb-meta"><code>${esc(p.id)}</code> · edited ${time(p.mtime)}${
      p.lastEvent ? ` · last submit ${time(Date.parse(p.lastEvent))}` : ''}${
      p.listeners ? ` · <span class="wb-waiting">agent waiting</span>` : ''}</span></li>`).join('')}</ul>`
}

/**
 * @param {() => { templates: Map<string, object>, code: object | null }} templates
 */
/** The folder's README, when it has one. */
function readmeOf(page) {
  const name = ['README.md', 'readme.md', 'Readme.md'].find(n => page.entries.some(e => !e.dir && e.name === n))
  if (!name) return null
  const file = path.join(page.file, name)
  return { file, source: fs.readFileSync(file, 'utf8') }
}

/** A stylesheet reference (URL, file: URL string, or absolute path) → absolute path. */
function stylePath(ref) {
  if (ref == null) return null
  const file = ref instanceof URL || String(ref).startsWith('file:') ? fileURLToPath(ref) : String(ref)
  if (!path.isAbsolute(file)) throw new Error(`basic({ style }): use a URL, e.g. new URL('./style.css', import.meta.url)`)
  if (!fs.existsSync(file)) throw new Error(`basic({ style }): file not found: ${file}`)
  return file
}

export function createRender(templates, style) {
  const STYLE = stylePath(style)
  async function markdown(source, page, file, ctx) {
    const { templates: set, code } = templates()
    return renderMarkdown(body(source), { page, file, resolve: name => set.get(name) ?? null, code, linkFor: ctx.urlFor })
  }

  async function content(page, ctx) {
    const { project } = ctx
    switch (page.kind) {
      case 'page':
        return markdown(page.source, page.id, page.file, ctx)
      case 'pages': {
        const links = [project.files && '<a href="/-/">files</a>', '<a href="/_/docs">templates</a>'].filter(Boolean).join(' · ')
        const list = page.pages.length ? pageList(page.pages) : '<p class="wb-meta">No pages yet.</p>'
        const html = page.id
          ? `<h1>${esc(page.id)}</h1>${list}<p class="wb-meta">${esc(page.file)}</p>`
          : `<h1>${esc(project.name)}</h1>${list}<p class="wb-meta"><code>${esc(project.dir)}</code> · ${links}</p>`
        return { html, title: page.id || project.name, islands: {}, styles: [] }
      }
      case 'folder': {
        const rel = page.id.slice(2)
        const up = rel ? `<li><a href="../">../</a></li>` : ''
        const rows = page.entries.map(e =>
          `<li><a href="${esc(encodeURIComponent(e.name) + (e.dir ? '/' : ''))}">${esc(e.name + (e.dir ? '/' : ''))}</a></li>`).join('')
        const listing = `<h1>${esc(rel || project.name)}</h1><ul class="wb-files">${up}${rows}</ul><p class="wb-meta">${esc(page.file)} · <code>${esc(page.id)}</code></p>`
        const readme = readmeOf(page)
        if (!readme) return { html: listing, title: rel || project.name, islands: {}, styles: [] }
        const r = await markdown(readme.source, page.id, readme.file, ctx)
        return { ...r, html: `${r.html}<hr>${listing}` }
      }
      case 'file': {
        // the file as one code block, rendered by the code template (or as plain code)
        const { code } = templates()
        const ext = path.extname(page.file).slice(1).toLowerCase()
        const tree = { type: 'root', children: [{ type: 'code', lang: CODE_LANG[ext] ?? (ext || null), meta: null, value: page.source }] }
        const out = await renderMarkdown(tree, { page: page.id, file: page.file, resolve: () => null, code, linkFor: ctx.urlFor })
        const html = `<h1 class="wb-code-title wb-wide">${esc(page.id.slice(2))}</h1><div class="wb-code wb-wide">${out.html}</div>`
        return { html, title: path.basename(page.file), islands: out.islands, styles: out.styles }
      }
    }
  }

  /** @type {import('../src/define.ts').Renderer['render']} */
  return async function render(page, ctx) {
    let out
    try {
      out = await content(page, ctx)
    } catch (err) {
      // a template set that does not resolve (a bad entry in basic({ templates }))
      out = { html: `<pre class="wb-error">${esc(err.message)}</pre>`, islands: {}, styles: [] }
    }
    const islands = Object.fromEntries(Object.entries(out.islands).map(([id, island]) => [id, { ...island, client: ctx.asset(island.client) }]))
    const styles = out.styles.map(s => ctx.asset(s))
    const nav = `<nav class="wb-nav"><span>${crumbs(page.id, ctx.project.name)}</span>${page.mtime ? `<span class="wb-meta">updated <time id="wb-updated" data-ts="${page.mtime}"></time></span>` : ''}<button type="button" class="wb-theme" title="Theme: follow the system, light or dark">auto</button><span class="wb-live" title="live reload"></span></nav>`
    return {
      title: out.title || page.id || ctx.project.name,
      head: `<script>try{const t=localStorage.getItem('wb-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch{}</script>
<link rel="stylesheet" href="${esc(ctx.asset(BASE_CSS))}">${styles.map(s => `<link rel="stylesheet" href="${esc(s)}">`).join('')}${STYLE ? `<link rel="stylesheet" href="${esc(ctx.asset(STYLE))}">` : ''}`,
      html: `${nav}<main id="wb-main">${out.html}</main>`,
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

/** The syntax of every template, from their readmes: what `whiteboard docs` prints. */
export function createDocs(templates) {
  return function docs(ctx) {
    const list = [...templates().templates.values()].sort((a, b) => a.name.localeCompare(b.name))
    const parts = list.map(t => {
      const what = [t.code && 'code blocks', t.client && 'client', t.html && 'html', t.props && 'props'].filter(Boolean).join(' · ')
      const where = `<p class="wb-meta">from <code>${esc(t.source)}</code>${what ? ` · ${what}` : ''}</p>`
      const readme = t.readme ? fs.readFileSync(t.readme, 'utf8') : `# ${t.name}\n\n_No readme._\n`
      return readme.replace(/^(#\s.*)$/m, `$1\n\n${where}\n`)
    })
    const intro = `# Templates\n\nThe basic renderer: markdown, with these templates in **${ctx.project.name}**: ${list.map(t => `[${t.name}](#${t.name})`).join(' · ')}\n\nPlain markdown, GFM tables, \`<details>\` and raw HTML \`<form name="…">\` work without templates.\n\n${COMMENTS}\n\n---\n\n`
    return intro + parts.join('\n\n---\n\n')
  }
}
