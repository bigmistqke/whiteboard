// Comments, as a whiteboard plugin: on every page the reader selects a passage and comments on it,
// and the agent replies in the thread or edits the page. Built in: every project has it.
//
// A thread is events on the page (see client.ts), so the server has nothing to do but serve the
// browser module and the styles, and tell agents how to answer (`whiteboard docs`).
import { packagePath } from '../../src/package.ts'
import type { Plugin } from '../../src/define.ts'

const CLIENT = packagePath('dist/plugins/comments/client.js')
const STYLE = packagePath('dist/plugins/comments/style.css')

const DOCS = `## Comments

The reader can select text on any page and comment on it. Each comment comes
to you as an event on the page, like a form answer:

\`\`\`json
{"id":"…","page":"plan","type":"comments:new","data":{"quote":"the selected text","before":"…","after":"…","block":3,"text":"their comment"}}
\`\`\`

Replies to a thread come as \`comments:reply\` (\`data.replyTo\` is the comment's
id), and \`comments:resolve\` when the reader closed it. A thread stays on the
page until the reader closes it. Answer a comment the way it asks:

- **It asks for a change:** edit the page. The thread stays, so say what you
  changed in a reply if it is not obvious.
- **It asks a question:** reply in the thread:
  \`whiteboard append --page <file> --type comments:reply --data '{"replyTo":"<comment id>","text":"…"}'\`

Your replies show as the agent's, and \`wait\` and \`watch\` skip what you
append, so you don't hear your own replies.`

export default function comments(): Plugin {
  return {
    name: 'comments',
    docs: () => DOCS,
    events: {
      'comments:new': { handOut: true, description: 'a comment on a passage: `{ quote, before, after, block, text }`; its id is the thread\'s' },
      'comments:reply': { handOut: true, description: 'a reply in a thread: `{ replyTo, text }`' },
      'comments:resolve': { description: 'the reader closed a thread: `{ replyTo }`' },
    },
    style: STYLE,
    setup: () => ({ client: CLIENT }),
  }
}
