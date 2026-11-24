# Writing a plugin

How to extend whiteboard. The plugins in this folder are the built-in ones,
and the best examples: each one's `README.md` is what `whiteboard docs` tells
an agent writing pages; this file is for writing a plugin of your own.

Everything that extends whiteboard is a plugin: syntax for pages,
behaviour on every page, commands, events. A plugin is an object with a
name, and everything it adds lives under that name, so two plugins can't
collide: its block `:::name`, its events `name:…`, its command
`whiteboard name`, its routes `/api/name/…` and its data folder
`.whiteboard/name/`. Local plugins go in `.whiteboard/plugins/`.

## A block: a checklist the reader ticks

A block is syntax: `:::name` around content, `::name` on a line, `:name`
inside a line, or a code fence of that name. It renders on the server, and
with a `client` it is mounted in the browser too.

```ts
// .whiteboard/plugins/checklist/index.ts
import { definePlugin, html, type DirectiveContext } from '@bigmistqke/whiteboard'

const toText = (node: any): string => node.value ?? (node.children ?? []).map(toText).join('')

export default function checklist() {
  return definePlugin({
    name: 'checklist',
    blocks: {
      checklist: {
        // what the browser part gets: the block's list items as text
        props: ctx => {
          const c = ctx as DirectiveContext   // a block (`:::checklist`), not a code fence
          return {
            name: c.attrs.name ?? 'checklist',
            items: (c.children as any[]).filter(n => n.type === 'list')
              .flatMap(list => list.children.map((item: any) => toText(item))),
          }
        },
        // shown until the client mounts, then replaced
        html: () => html`<ul class="checklist"></ul>`,
        client: 'client.js',   // in its public/ folder
      },
    },
    // its events, and whether a `wait` on the page hands them out (a tick is information: no)
    events: { 'checklist:tick': { description: '`{ checklist, item, checked }`' } },
    // for `whiteboard docs`, under a `# Plugin: checklist` heading the core adds
    docs: () => 'A list the reader ticks:\n\n    :::checklist{name=launch}\n    - Write the changelog\n    :::\n',
  })
}
```

```js
// .whiteboard/plugins/checklist/public/client.js: its public/ folder is served, nothing else of it
export default function mount(el, { name, items }, api) {
  const ticked = () => {
    const state = new Map()
    for (const e of api.events()) if (e.type === 'checklist:tick' && e.data.checklist === name) state.set(e.data.item, e.data.checked)
    return state
  }
  const draw = () => {
    const state = ticked()
    el.replaceChildren(...items.map(item => {
      const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !!state.get(item) })
      box.addEventListener('change', () => api.append('checklist:tick', { checklist: name, item, checked: box.checked }))
      const label = document.createElement('label')
      label.append(box, ' ', item)
      return label
    }))
  }
  draw()
  // the page's events, also the ones it appends itself, come back here
  return api.events.on(draw)
}
```

```ts
// .whiteboard/config.ts
import { defineConfig } from '@bigmistqke/whiteboard'
import checklist from './plugins/checklist/index.ts'

export default defineConfig({ plugins: [checklist()] })
```

An agent can wait for a tick by asking for it: `whiteboard wait --page
<file> --type checklist:tick`.

## Behaviour on every page: votes

A plugin can also put something on every page, and add commands:

```ts
// .whiteboard/plugins/votes/index.ts
import { definePlugin } from '@bigmistqke/whiteboard'
import { read } from '@bigmistqke/whiteboard/log'

export default function votes() {
  return definePlugin({
    name: 'votes',
    events: { 'votes:up': { description: 'the reader voted the page up' } },
    commands: {
      '': {
        description: 'print the votes per page',
        run(ctx) {
          const counts = new Map<string, number>()
          for (const e of read(ctx.eventsFile).events) if (e.type === 'votes:up') counts.set(e.page, (counts.get(e.page) ?? 0) + 1)
          for (const [page, n] of counts) console.log(`${page}: ${n}`)
        },
      },
    },
    docs: () => 'The reader can vote a page up: a `votes:up` event. `whiteboard votes` counts them.',
    // from setup: what the running server adds (routes, what it puts in its slots, the browser module)
    setup: () => ({ client: 'client.js' }),
  })
}
```

```js
// .whiteboard/plugins/votes/public/client.js
export default function mount(root, page, api) {
  const button = document.createElement('button')
  const draw = () => { button.textContent = `👍 ${api.events().filter(e => e.type === 'votes:up').length}` }
  button.addEventListener('click', () => api.append('votes:up'))
  api.slot('corner', el => {   // its own element in the page's corner, for floating buttons
    el.append(button)
    return () => button.remove()
  })
  api.events.on(draw)
  draw()
}
```

## What a plugin can have

- **`blocks`**, by name. A block has `html(ctx)` (the server's HTML; `ctx`
  has the block's attributes, label, content as mdast nodes, `toHtml`,
  `items()`, `fileUrl(src)` for the address of a file beside the page, and
  more), `props(ctx)` (JSON for its client), `client` (a
  browser module, mounted per block), `style` (linked on pages that use it),
  `fence: true` to also take the code fences of its name (```` ```mermaid ````),
  `fence: 'any'` for the block that takes every code fence nobody else
  claims, and `open(ctx)`: what it shows on its own, for a window around it.
  Block names are unique across a project's plugins.
- **`compose(ctx)`**: itself around any block that names the plugin in its
  `compose` attribute, that block's HTML as `ctx.children` (see below).
- **`events`**, by type (`<plugin>:<what>`): a description each, and
  `handOut: true` for those an agent should get unasked, like a chat
  message. `whiteboard docs` lists them.
- **`style`**: a stylesheet on every page.
- **`docs`**: markdown for agents: how to write its blocks, what its events
  mean, how to answer.
- **`commands`**: `whiteboard <name>` and `whiteboard <name> <sub>`, with
  declared options that the core parses and checks. A command gets the
  project, its event log (`ctx.eventsFile`, for
  `@bigmistqke/whiteboard/log`), its token and server, what is open on each
  page (`ctx.status`), and handing out (`ctx.handOut`, what `wait` does).
- **`session()`**: the agent session a command runs in, for a plugin that
  knows how its agent says so.
- **`setup(ctx)`**, which runs once per loaded config on the server and
  returns:
  - `routes`, by method and path (`'POST /start'` is mounted at
    `/api/<name>/start`), each with what it does, whether it needs the
    project's token (`auth`), and the types of its body and query; the core
    checks all of that before the route's code runs;
  - `slots`, markup for its element in the page's slots, there on the first
    render (see below), and `head` for `<head>`;
  - `client`, a module on every page, run once per page load.

**A plugin puts what it adds to the page in slots**, places the core owns:
`header` (the header bar, before the theme button), `aside` (a panel beside
the text), `bottom` (a drawer the page makes room for), `overlay` (over the
page) and `corner` (floating buttons and toasts). Each plugin has its own
element in each. Its `slots(req)` can render markup into them on the server,
so it is there on the first paint; its browser module mounts on its element
with `api.slot('bottom', el => unmount)`, handed to it whether the server
filled it or not, and what the mount returns runs when the element is taken
away. A plugin never looks the element up, and its markup names no
addresses: it names its files (`client`, `style`) and the core makes them.

```ts
// server: the drawer, there on the first render
setup: () => ({
  client: 'client.js',
  slots: () => ({ bottom: html`<aside class="drawer">…</aside>` }),
}),

// browser (client.js): mounts on it
export default (root, page, api) =>
  api.slot('bottom', el => {
    const drawer = open(el.firstElementChild)
    return () => drawer.close()
  })
```

**A plugin can compose itself around other blocks.** With `compose`, a
block whose `compose` attribute names the plugin is put in what it returns,
the block's HTML as `children`, as a component gets what it wraps. The
window plugin is one: `::image{src compose=window}`, ```` ```mermaid {compose=window} ````
and `:::grid{compose=window}` all go in a window, and none of those blocks
knows of windows. A block says what it shows on its own with `open` (an
image's file), which a window's ↗ opens. Several named compose in the order
written, the first innermost: `compose=lightbox,window`. A name no plugin
composes is said in place.

```ts
definePlugin({
  name: 'window',
  compose: ({ children, label, open }) => windowFrame({ label, open, body: children }),
})
```

**A plugin's browser files live in its `public/` folder**, and only that
folder is served: its client modules, styles, images and fonts, never its
server code or the project's files beside it. `client` and `style` (a
plugin's and a block's) name files in it: `'client.js'`. `definePlugin` puts
it next to the module that calls it (`plugins/checklist/public/` for
`plugins/checklist/index.ts`); say another with `public: new URL('./assets/',
import.meta.url)`; a plain object plugin, or one written in the config, has
`.whiteboard/public/`. A file named outside it is a config error. Browser
code is JavaScript or TypeScript: a `.ts` file is served with its types
stripped (Node's type stripping, as for server code: types only, so no
`enum` or `namespace`, and imports name their `.ts` files). JSX still needs
building first. A block's `client` gets
`mount(element, props, api)` and may return a cleanup, run when the block
is replaced on a live update; it replaces the server's HTML when it mounts.
A page module (`setup`'s `client`) gets `mount(root, page, api)`. Both get
the page's `api`: its `events` and `append` (which comes back through
`events.on`), the `listeners`, `forms` and `unread` messages, `onRendered`
(after a live update, to put back what it adds), the page's `frontmatter`
on the page handle (YAML, as parsed) and the plugin's own `settings` in it
(under `plugins:` by its name: `plugins: { toc: true }` is `true` for toc), `slot()` for its elements in the page's slots, `toast()` for a label in
the corner that says what is going on and goes there (one that hides after a
few seconds, or one that stays with a count), `badge()` for counts in the
tab title, the `theme`, and `url(path)`: the address of one of the
project's server routes as this page requests it (`api.url('/api/votes/count')`).
Ask for the plugin's routes through it rather than writing `/api/…`: under a
shared server a project is served below a path (`/rg/develop`). Every value
that changes is called for what it
is now and has `.on(fn)` for each change: `api.events()`,
`api.events.on(draw)`, `page.frontmatter.on(…)`. Files beside a browser module that are browser
assets (scripts, styles, images, fonts) are served too.

Something that covers the bottom of the window says how much in
`--wb-inset-bottom`, and the page keeps clear of it. A plugin can't be
named like a built-in command or a folder of the core.

## Patterns in the built-in plugins

| want | look at |
| --- | --- |
| a block with a browser part | `checklist` above; `steps/` |
| a block around other blocks (`compose`) | `window/`, `lightbox/` |
| markup there on the first paint, a drawer the page makes room for (`bottom`) | `terminal/` |
| a button in the header bar and a panel beside the text (`header`, `aside`) | `toc/` |
| things over the page, placed in document coordinates (`overlay`) | `comments/` |
| a browser module that works on every page's content | `code/` (measures code blocks), `lightbox/` |
| events an agent gets, answered in place | `chat/`, `comments/` |
| commands and routes | `terminal/` (both), `claude-code/` (commands) |
