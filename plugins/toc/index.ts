// A table of contents beside the page: its sections (## and ### headings), numbered as the page
// numbers them, the one being read marked, a dot where something waits for the reader (an
// unanswered question, an unread message). In the margin left of the text when the window has room
// for it; else a button in the header that opens it. A project turns it on in its config:
//
//   import toc from '@bigmistqke/whiteboard/toc'
//   export default defineConfig({ plugins: [toc()] })
import { packagePath } from '../../src/package.ts'
import type { Plugin } from '../../src/define.ts'

const DOCS = `## Table of contents

Pages here have a table of contents beside them, made from their \`##\` and
\`###\` headings: give a long page headings, and the reader can find their way
in it. A section with an unanswered question or an unread message has a dot.
`

export default function toc(): Plugin {
  return {
    name: 'toc',
    docs: () => DOCS,
    style: packagePath('dist/plugins/toc/style.css'),
    setup: () => ({ client: packagePath('dist/plugins/toc/client.js') }),
  }
}
