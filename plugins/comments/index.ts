// Comments, as a whiteboard plugin: on every page the reader selects a passage and comments on it,
// and the agent replies in the thread or edits the page. Built in: every project has it.
//
// A thread is events on the page (see client.ts), so the server has nothing to do but serve the
// browser module and the styles, and tell agents how to answer (`whiteboard docs`).
import { builtinPublic } from '../../src/package.ts'
import type { Plugin, WbEvent } from '../../src/define.ts'
import { item, when } from '../../src/archive.ts'

const DOCS = `## Comments

The reader can select text on any page and comment on it, or comment on
whole lines of a code block (a "+" beside each line; dragging it takes
several). Each comment comes to you as an event on the page, like a form
answer:

\`\`\`json
{"id":"…","page":"plan","type":"comments:new","data":{"quote":"the selected text","before":"…","after":"…","block":3,"text":"their comment"}}
\`\`\`

On lines that say where they are from, \`data.at\` says it too: in a
\`diff\` fence, \`"src/a.ts:12"\` (a line of the new file), \`"src/a.ts (old):9"\`
(a removed line), or \`"src/a.ts:12 – src/a.ts:15"\` for several. Any block
can say where its parts are from with a \`data-wb-at\` attribute.

Replies to a thread come as \`comments:reply\` (\`data.replyTo\` is the comment's
id), and \`comments:resolve\` when the reader closed it. A thread stays on the
page until the reader closes it. Answer a comment the way it asks:

- **It asks for a change:** edit the page. The thread stays, so say what you
  changed in a reply if it is not obvious.
- **It asks a question:** reply in the thread:
  \`whiteboard append --page <file> --type comments:reply --data '{"replyTo":"<comment id>","text":"…"}'\`

Your replies show as the agent's, and \`wait\` and \`watch\` skip what you
append, so you don't hear your own replies. Comments and replies are
markdown: code in backticks or fences, lists, links, \`#12\`; raw HTML and
blocks (\`:::…\`, \`:button\`) show as written.`

export default function comments(): Plugin {
  return {
    name: 'comments',
    docs: () => DOCS,
    archive: archiveComments,
    events: {
      'comments:new': {
        handOut: true,
        description:
          "a comment on a passage or lines of code: `{ quote, before, after, block, at?, text }`; its id is the thread's",
      },
      'comments:reply': { handOut: true, forReader: true, description: 'a reply in a thread: `{ replyTo, text }`' },
      'comments:resolve': { description: 'the reader closed a thread: `{ replyTo }`' },
    },
    public: builtinPublic('comments'),
    style: 'style.css',
    setup: () => ({ client: 'client.js' }),
  }
}

/** An archived page's comments: each thread, the passage it is on, its replies, and whether it was closed. */
function archiveComments(events: WbEvent[]) {
  const threads = events.filter(e => e.type === 'comments:new')
  if (!threads.length) return
  const who = (e: WbEvent) => (e.from === 'cli' ? 'agent' : 'you')
  return [
    '## Comments',
    ...threads.map(c => {
      const replies = events.filter(e => e.type === 'comments:reply' && e.data.replyTo === c.id)
      const closed = events.some(e => e.type === 'comments:resolve' && e.data.replyTo === c.id)
      const on = String(c.data.quote ?? c.data.at ?? '').trim()
      return [
        `### On ${on ? `“${on.length > 80 ? on.slice(0, 80) + '…' : on}”` : 'the page'}${closed ? ' (closed)' : ''}`,
        [c, ...replies].map(e => item(`${who(e)}, ${when(e)}`, String(e.data.text ?? ''))).join('\n'),
      ].join('\n\n')
    }),
  ].join('\n\n')
}
