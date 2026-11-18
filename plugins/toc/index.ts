// A table of contents beside the page: its sections (## and ### headings), numbered as the page
// numbers them, the one being read marked, a dot where something waits for the reader (an
// unanswered question, an unread message). In the margin left of the text when the window has room
// for it; else a button in the header that opens it. A project turns it on in its config:
//
//   import toc from '@bigmistqke/whiteboard/toc'
//   export default defineConfig({ plugins: [toc()] })
//
// A page has it when its frontmatter says `toc: true`. With `toc({ always: true })`, every page has
// it, unless its frontmatter says `toc: false`.
import { builtinPublic } from '../../src/package.ts'
import { html } from '../../src/html.ts'
import type { Plugin } from '../../src/define.ts'

const DOCS = `## Table of contents

Pages here have a table of contents beside them, made from their \`##\` and
\`###\` headings: give a long page headings, and the reader can find their way
in it. A section with an unanswered question or an unread message has a dot.
`

export interface TocOptions {
  /** on every page, not only the ones whose frontmatter says `toc: true` (`toc: false` still goes without) */
  always?: boolean
  /** the panel fits its items, but never narrower than this: a CSS length, or pixels (default 160px) */
  minWidth?: string | number
  /** nor wider than this (default 320px); a page's frontmatter can say otherwise: `toc: { maxWidth: 280px }` */
  maxWidth?: string | number
}

export default function toc(options: TocOptions = {}): Plugin {
  return {
    name: 'toc',
    docs: () =>
      options.always
        ? DOCS + '\nIn this project every page has it; a page without it says `toc: false` in its frontmatter.\n'
        : DOCS +
          '\nA page has it when its frontmatter says `toc: true`:\n\n```markdown\n---\ntoc: true\n---\n# A long page\n```\n',
    public: builtinPublic('toc'),
    style: 'style.css',
    setup: () => ({
      client: 'client.js',
      // how the browser part knows: on every page, or only where the frontmatter asks
      shell: () => ({
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
