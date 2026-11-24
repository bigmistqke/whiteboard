import fs from 'node:fs'
import { definePlugin, type Plugin } from '@bigmistqke/whiteboard'
// Syntax highlighting for code blocks, on the server with Shiki: the page gets plain HTML, no script.
//
// Built in; for options, replace it in the config: plugins: [code({ themes: { light, dark } })].
//
// Its block takes `fence: 'any'`, so it renders every fence no other block claims by name, and the
// code view of repository files.
//
// Every token carries both a light and a dark colour as CSS variables (--shiki-light,
// --shiki-dark); style.css picks one per theme, so highlighting follows the theme toggle without
// re-rendering. The block's background stays the page's own code background.
//
// A `diff` fence is shown for reading (see diff.ts): its header lines go, except the file's name;
// a hunk's start is a `⋯` where lines are skipped; each line says what it is (`data-diff`: add, del,
// context, hunk, file), its number (`data-n`, drawn in a gutter by style.css, so it is never part
// of the text) and where it is (`data-wb-at="file:line"`), which comments on the line record.
// shiki loads the first time a page has code, not with the plugin: the command line loads the
// built-in plugins too, for their declarations
import type * as Shiki from 'shiki'
import type { BundledTheme, Highlighter } from 'shiki'
import type { FenceContext } from '@bigmistqke/whiteboard'
import { diffLines } from './diff.ts'
import { builtinPublic } from '../../src/package.ts'

export interface Options {
  /** Shiki theme names for each page theme (default: GitHub light and dark) */
  themes?: { light: BundledTheme; dark: BundledTheme }
  /** per theme, colours to swap: { 'github-light': { '#e36209': '#0f766e' } } */
  colorReplacements?: Record<string, Record<string, string>>
}

const DEFAULT_THEMES = { light: 'github-light', dark: 'github-dark' } as const

// the default palette has no orange or brown: the GitHub themes' oranges become a teal
const DEFAULT_REPLACEMENTS = {
  'github-light': { '#e36209': '#0f766e', '#b08800': '#0f766e' },
  'github-dark': { '#ffab70': '#5eead4', '#c24e00': '#2dd4bf' },
}

export default function code(options: Options = {}): Plugin {
  const themes = options.themes ?? DEFAULT_THEMES
  const colorReplacements = options.colorReplacements ?? (options.themes ? {} : DEFAULT_REPLACEMENTS)
  let highlighter: Promise<Highlighter> | undefined
  // loaded the first time a page has code, not with the plugin: the command line loads plugins too
  let shiki: typeof Shiki | undefined
  const loaded = new Set<string>()

  /**
   * Highlight `code` as `lang`; an unknown or missing language renders as plain text. A long line
   * scrolls the block sideways; with `wrap` it wraps at the block's edge.
   */
  async function highlight(code: string, lang: string | null, wrap = false) {
    shiki ??= await import('shiki')
    highlighter ??= shiki.createHighlighter({ themes: Object.values(themes), langs: [] })
    const h = await highlighter
    let language = String(lang ?? '').toLowerCase()
    if (language in shiki.bundledLanguages) {
      if (!loaded.has(language)) {
        await h.loadLanguage(language as keyof typeof shiki.bundledLanguages)
        loaded.add(language)
      }
    } else language = 'text'
    const diff = language === 'diff' ? diffLines(code) : null
    const transformers: Shiki.ShikiTransformer[] = []
    // a fence that says {wrap}: its long lines wrap (style.css)
    if (wrap)
      transformers.push({
        pre(node) {
          node.properties['data-wrap'] = ''
        },
      })
    if (diff)
      transformers.push({
        line(node, n) {
          const info = diff[n - 1]
          if (!info) return
          node.properties['data-diff'] = info.kind
          if (info.n != null) node.properties['data-n'] = String(info.n)
          if (info.at) node.properties['data-wb-at'] = info.at
          // a file's headers read as its name; a hunk's header as nothing but the gutter's `⋯`
          if (info.label != null) node.children = [{ type: 'text', value: info.label }]
        },
        // the headers nobody reads go, with the line break after each
        code(node) {
          node.children = node.children.filter((child, i, all) => {
            const isMeta = (c: typeof child | undefined) =>
              c?.type === 'element' && c.properties['data-diff'] === 'meta'
            return !isMeta(child) && !(child.type === 'text' && isMeta(all[i - 1]))
          })
        },
      })
    return h.codeToHtml(code, {
      lang: language,
      themes,
      defaultColor: false,
      colorReplacements,
      transformers,
    })
  }

  return definePlugin({
    name: 'code',
    public: builtinPublic('code'),
    // measures whether each code block overflows, so its scrollbar is chosen in advance (client.ts:
    // a WebKit layout bug)
    setup: () => ({ client: 'client.js' }),
    blocks: {
      code: {
        // every code fence no other block claims by name, and the code view of repository files
        fence: 'any',
        html: ctx => highlight((ctx as FenceContext).text, (ctx as FenceContext).lang, 'wrap' in ctx.attrs),
        style: 'style.css',
      },
    },
    docs: () => fs.readFileSync(new URL('./README.md', import.meta.url), 'utf8'),
  })
}
