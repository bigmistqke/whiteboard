// Comments, as a whiteboard plugin: on every page, whatever renderer drew it, the reader selects a
// passage and comments on it, and the agent replies in the thread or edits the page. In a config:
//
//   import comments from '@bigmistqke/whiteboard/comments'
//   export default defineConfig({ renderers: [markboard()], plugins: [comments()] })
//
// A thread is events on the page (see client.ts), so the server has nothing to do but serve the
// browser module and the styles, and tell agents how to answer (`whiteboard docs`).
import { html } from '../src/html.ts'
import { packagePath } from '../src/package.ts'
import type { Plugin } from '../src/define.ts'

const CLIENT = packagePath('dist/comments/client.js')
const STYLE = packagePath('dist/comments/style.css')

const DOCS = `## Comments

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

export default function comments(): Plugin {
  return {
    name: 'comments',
    docs: () => DOCS,
    setup(ctx) {
      const style = ctx.asset(STYLE)
      return {
        client: CLIENT,
        shell: () => ({ head: html`<link rel="stylesheet" href="${style}">` }),
      }
    },
  }
}
