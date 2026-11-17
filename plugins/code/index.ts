import fs from 'node:fs'
import { definePlugin, type Plugin } from '@bigmistqke/whiteboard'
// Syntax highlighting for code blocks, on the server with Shiki: the page gets plain HTML, no script.
//
// Part of markboard(); pass options through it: markboard({ code: { themes: { light, dark } } }).
//
// Its block takes `fence: 'any'`, so it renders every fence no other block claims by name, and the
// code view of repository files.
//
// Every token carries both a light and a dark colour as CSS variables (--shiki-light,
// --shiki-dark); style.css picks one per theme, so highlighting follows the theme toggle without
// re-rendering. The block's background stays the page's own code background.
import { createHighlighter, bundledLanguages, type BundledTheme, type Highlighter } from 'shiki'
import type { FenceContext } from '@bigmistqke/whiteboard/template'

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
  const loaded = new Set<string>()

  /** Highlight `code` as `lang`; an unknown or missing language renders as plain text. */
  async function highlight(code: string, lang: string | null) {
    highlighter ??= createHighlighter({ themes: Object.values(themes), langs: [] })
    const h = await highlighter
    let language = String(lang ?? '').toLowerCase()
    if (language in bundledLanguages) {
      if (!loaded.has(language)) {
        await h.loadLanguage(language as keyof typeof bundledLanguages)
        loaded.add(language)
      }
    } else language = 'text'
    return h.codeToHtml(code, { lang: language, themes, defaultColor: false, colorReplacements })
  }

  return definePlugin({
    name: 'code',
    blocks: {
      code: {
        // every code fence no other block claims by name, and the code view of repository files
        fence: 'any',
        html: ctx => highlight((ctx as FenceContext).text, (ctx as FenceContext).lang),
        style: new URL('./style.css', import.meta.url),
      },
    },
    docs: () => fs.readFileSync(new URL('./README.md', import.meta.url), 'utf8'),
  })
}
