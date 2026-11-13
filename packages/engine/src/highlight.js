// Syntax highlighting for code blocks, on the server with Shiki: the page gets plain HTML, no script.
//
// Every token carries both a light and a dark colour as CSS variables (--shiki-light,
// --shiki-dark); base.css picks one per theme, so highlighting follows the theme toggle without
// re-rendering. The block's background stays the page's own code background.
import { createHighlighter, bundledLanguages } from 'shiki'

const THEMES = { light: 'github-light', dark: 'github-dark' }

// the palette has no orange or brown: the GitHub themes' oranges become a teal
const REPLACE = {
  'github-light': { '#e36209': '#0f766e', '#b08800': '#0f766e' },
  'github-dark': { '#ffab70': '#5eead4', '#c24e00': '#2dd4bf' },
}

let highlighter
const loaded = new Set()

/** Highlight `code` as `lang`; an unknown or missing language renders as plain text. */
export async function highlight(code, lang) {
  highlighter ??= createHighlighter({ themes: Object.values(THEMES), langs: [] })
  const h = await highlighter
  let language = String(lang ?? '').toLowerCase()
  if (language in bundledLanguages) {
    if (!loaded.has(language)) {
      await h.loadLanguage(language)
      loaded.add(language)
    }
  } else language = 'text'
  return h.codeToHtml(code, { lang: language, themes: THEMES, defaultColor: false, colorReplacements: REPLACE })
}
