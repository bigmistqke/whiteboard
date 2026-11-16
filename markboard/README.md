# markboard

The renderer that ships with whiteboard. Pages are markdown, extended by
templates, and each page is a conversation between you and the agent that
writes it: forms you answer, a thread under each form, comments on any
passage, and a page that shows at a glance what waits on whom.

```ts
// .whiteboard/config.ts
import { defineConfig } from '@bigmistqke/whiteboard/config'
import markboard from '@bigmistqke/whiteboard/markboard'

export default defineConfig({
  renderers: [markboard()],
})
```

`whiteboard init` writes this config.

## A page

````markdown
# Release plan

:::callout[Status: one question open]{.note}
The parser is done; the docs wait on the question below.
:::

:::grid{cols=2}
### Parser {done}
Rewritten, all tests pass.

### Docs {todo}
Not started.
:::

:::form{name=ship}
**When do we ship?**

- :radio[This week]{name=when recommended}
  The docs are small; ship and follow up.
- :radio[Next week]{name=when}
  Ship with the docs complete.
:::
````

Plain markdown and GFM work as they are (tables, task lists, `<details>`,
raw HTML). Templates add the rest: `:::name` containers, `::name` lines,
`:name` inline, and ```` ```name ```` fenced blocks.

## Talking it through

Everything you do on a page is an event in the project's log, which the
agent reads with `whiteboard wait`. The page shows what the agent is doing
from the same log, so nothing depends on the agent remembering to say it.

### Forms

A named form records each submit: its name is the event's `type`, the
button pressed its `action`, the fields its `data`. The `form` template
writes a form as markdown with its inputs inline, so a question sits with
everything that explains it, and each option with what it means:

- **A send is a choice.** The writer's recommended option is tagged, never
  preselected: a choice is only made by picking it.
- **A thread under every form.** Ask about a question without answering it.
  What you write there is a `thread` event, never a submit, so talking about
  a choice never makes it. The agent answers in the same thread; it reads
  as a chat, your messages on one side and the agent's on the other. Enter
  sends, Shift+Enter starts a new line, and the box grows with your text.
- **Drafts survive.** What you type into a form is kept until you send it,
  across live updates and reloads (with the forms extension, below).

### What waits on whom

Sending a form, its drafts and these marks come from the forms extension
(`@bigmistqke/whiteboard/forms`, in the config's `extensions`; `whiteboard
init` adds it), so they work on a page of any renderer. A form is in one of
four states, read from the log and from who is
listening right now (a running `whiteboard wait` or `watch`):

| state | means |
| --- | --- |
| **waiting for you** | an agent is listening and wants this answer |
| **nobody listening** | no answer yet, and no agent would hear one now |
| **waiting for the agent** | answered, but no agent has picked the answer up yet |
| **decided** | an agent picked up the latest answer: the form folds into one line quoting it; a click opens it again to change it |

A line above the page counts the states and jumps through each, a button
jumps from one form waiting for you to the next, and the tab title gets a
`(!n)` prefix. The overview of all pages marks the ones an agent waits on.

### Comments

Select any passage and a "Comment" button appears. A comment opens a thread
in the margin, and the agent replies there or edits the page. Passages are
found again by their quote and its surroundings after edits, and
highlighted without touching the page's markup. A thread stays until you
close it.

### What changed

Every save of the page updates the open tab in place. A block whose content
you haven't seen gets a bar on its left until it has been in view for a
moment, and buttons jump to the next unseen block (the ✕ in them marks
everything seen). What you've seen is remembered per page, so coming back
later shows what changed since. Content inside `:::quiet` never counts as
new: it's for the agent echoing your answer or updating a status line.

## Reading

- **Live, without losing your place.** Updates are patched into the page:
  focus, the caret, typed values, open `<details>` and your scroll position
  all survive.
- **A frame** with breadcrumbs, when the page was last updated, a theme
  toggle (light, dark or the system's) and a live indicator.
- **Numbered sections.** Headings are numbered, so a page can refer to
  "section 3"; write headings without numbers.
- **An overview** of the project's pages, with when each was edited and
  answered and which an agent waits on, and below it every markdown document
  in the project (READMEs, design notes, skills), each linked to its
  rendered page.
- **Repository files too.** `/-/README.md` renders that file as a page,
  `/-/src/` lists a folder with its README on top, and other text files show
  as highlighted code. Relative links work as they do in the repository.
- **Never broken.** An unknown template renders its content as plain
  markdown, and a template that throws shows an error in place of that block
  only.

## Templates

| template | for |
| --- | --- |
| `form` | a named form written as markdown, with inline inputs (`:radio`, `:check`, `:text`, …) and a thread |
| `grid` | cards in a grid, with status badges |
| `gallery` | images with a lightbox |
| `details` | a collapsible section |
| `callout` | a highlighted note, tip or warning |
| `mermaid` | Mermaid diagrams, rendered on the server |
| `code` | syntax highlighting for code blocks (Shiki) |
| `quiet` | content that is never marked as new |

Each template's syntax, with live examples, is at `/_/docs` on the running
server and printed by `whiteboard docs`. The agent reads it from there, so
it always matches the templates the project actually has.

## Options

```ts
markboard({
  templates: [timeline],      // your own; one with the name of a built-in replaces it
  code: { themes: { light: 'github-light', dark: 'github-dark' } },   // the highlighter's options
  style: new URL('./style.css', import.meta.url),                      // linked on every page, after markboard's own
})
```

## Writing a template

A template is an object. It can render HTML on the server, run a component
in the browser, or both:

```ts
// .whiteboard/templates/timeline.ts
import type { Template } from '@bigmistqke/whiteboard/template'

export default {
  name: 'timeline',
  html: ctx => `<ol class="timeline">…</ol>`,             // server: the block's HTML
  client: new URL('./timeline.js', import.meta.url),      // browser: default export mount(el, props, api)
  style: new URL('./timeline.css', import.meta.url),      // linked on pages that use it
  readme: new URL('./timeline.md', import.meta.url),      // its syntax, shown by `whiteboard docs`
} satisfies Template
```

Pass it to `markboard({ templates: [timeline] })`. Browser code can be
written in any framework; `@bigmistqke/whiteboard/solid` turns a Solid
component into a client, with the page's events and theme as signals. A
template with `code: true` also renders every code block no other template
claims.

The template's server side can be TypeScript: Node runs it as it is. The
browser gets the `client` file as it is too, so a client written in
TypeScript or JSX needs building to JavaScript first; the server reloads
the open pages when that file changes. markboard's own templates ship
built. [DESIGN.md](../DESIGN.md#templates) has the full contract.
