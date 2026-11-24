// A table of contents beside the page: its sections (## to ###### headings), numbered as the page
// numbers them, each one's subsections on a rail under it, the one being read marked, a dot where
// something waits for the reader (an unanswered question, an unread message). In the margin left
// of the text when the window has room for it; else a button in the header that opens it.
//
// Built in (plugins/index.ts): a page has it when its frontmatter says so, under `plugins:`
// (`plugins: { toc: true }`). A config that replaces it with `toc({ always: true })` puts it on
// every page, unless a page's frontmatter says `toc: false` there.
import { builtinPublic } from '../../src/package.ts'
import { html } from '../../src/html.ts'
import type { Plugin } from '../../src/define.ts'

const DOCS = `## Table of contents

Pages here have a table of contents beside them, made from their headings,
\`##\` down to \`######\`: give a long page headings, and the reader can find
their way in it. Each section's subsections hang on a line under it, so the
nesting shows. A section with an unanswered question or an unread message has
a dot.
`

export interface TocOptions {
  /** on every page, not only the ones that ask (`plugins: { toc: true }`); `toc: false` there still goes without */
  always?: boolean
  /** the panel fits its items, but never narrower than this: a CSS length, or pixels (default 160px) */
  minWidth?: string | number
  /** nor wider than this (default 320px); a page can say otherwise: `plugins: { toc: { maxWidth: 280px } }` */
  maxWidth?: string | number
}

export default function toc(options: TocOptions = {}): Plugin {
  return {
    name: 'toc',
    docs: () =>
      options.always
        ? DOCS +
          '\nIn this project every page has it; a page goes without with `toc: false` under `plugins:` in its frontmatter:\n\n```markdown\n---\nplugins:\n  toc: false\n---\n```\n'
        : DOCS +
          '\nA page has it when its frontmatter asks, under `plugins:`:\n\n```markdown\n---\nplugins:\n  toc: true\n---\n# A long page\n```\n',
    public: builtinPublic('toc'),
    style: 'style.css',
    setup: () => ({
      client: 'client.js',
      // how the browser part knows: on every page, or only where the frontmatter asks
      slots: () => ({
        head: html`<meta
          name="wb-toc"
          content="${options.always ? 'always' : 'opt-in'}"
          ${options.minWidth != null ? html` data-min-width="${String(options.minWidth)}"` : ''}
          ${options.maxWidth != null ? html` data-max-width="${String(options.maxWidth)}"` : ''}
        />`,
      }),
    }),
  }
}
