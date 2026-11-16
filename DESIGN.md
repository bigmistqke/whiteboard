# whiteboard — design

A whiteboard for a person and an agent: when something is too much for text
in a terminal, the agent writes a page and the person reads it live in a
browser. Pages can hold forms; submitting one appends an event to a log the
agent waits on, so both sides write on the board. The terminal stays for
conversation; the page holds overview, detail and decisions.

## Principles

- **Stored, not shown.** A page is stored as text, usually markdown. How it
  is shown is a renderer's choice, not the core's: the core reads pages as
  they are and hands them over. `markboard()` (markdown with templates) is one
  renderer; slides, a canvas or a React app could be others. A page no
  renderer takes shows as its raw text.
- **A light core.** The core keeps pages, the event log and the live
  channel between them and a browser. It draws nothing, compiles nothing and
  depends on no UI framework.
- **No agent concepts in the core.** There are no tasks, statuses or
  approvals. The one interaction primitive is appending an event to a page's
  log: a submitted form is one, a renderer can append others. Everything
  else is a renderer, a template, or a convention between an agent and its
  pages.
- **Everything added is a module.** Renderers, plugins and templates are
  objects (usually returned by a factory taking options) that a config imports from a
  package or a local file, the way bundler plugins work.
- **Agent-written pages must never break.** markboard renders an unknown
  directive as its content, an unknown fence as a code block, a template
  that throws as an error box in place of that block only. A broken config
  or a failing renderer shows its error above the raw text.
- **Self-documenting.** Each renderer documents how to write for it, served
  at `/_/docs` and printed by `whiteboard docs`, so agents read the current
  syntax instead of remembering it.

## Projects

A project is a folder (usually a repository) with a `.whiteboard/config.ts`.
Everything whiteboard keeps is in that `.whiteboard/` folder; nothing lives
outside the project:

```
<repo>/.whiteboard/
  config.ts     defineConfig({ name, renderers: [...], files })
  pages/        the project's pages, served at /<page>
  events.ndjson the project's events: form submits, threads, comments, and what agents picked up
  server.json   the port and process of the project's running server
  server.log    that server's output
  .gitignore    everything but config.ts: remove a line to keep it in git
```

`whiteboard init` creates it. Every command works on the project of the
current folder: the nearest folder upward with `.whiteboard/config.ts`. Outside
a project the commands stop and point to `whiteboard init`. An agent working
in the repository can start the server, write pages and read answers without
access outside it.

Each project runs its own server. `whiteboard show` starts it in the
background when it is not running: it takes the port it had last time, else
4777 (`$WHITEBOARD_PORT`), else the next free one, and records it in
`server.json`. The command line checks that the server on that port is this
project's before using it. Two projects open at once are two servers on two
ports; nothing coordinates them, and `/` lists only this project's pages.

Any other file in the project folder is served from the repository at
`/-/<path>`: markdown files as pages, folders with their entries, other text
files with their text, all handed to the renderer like any page; images and
other binary files are served as they are. `.git` is never served. The whole
project folder is watched so these views stay live.

`files: false` in the config turns that off: only `.whiteboard/` is served and
watched. It is for a project whose folder is not a repository, such as the
home folder, where serving every file would expose it and watching every file
would be slow. `whiteboard init` sets it when run in the home folder; a
project at `~` is also how to have pages for folders that have no project of
their own, since commands find the nearest project upward. A config that
fails to load serves no files either.

Several agents can work in one project at once, and a page and its forms
are addressed by name only. So an agent claims a page with `whiteboard new
<name>` instead of picking a file: it creates `pages/<name>.md`, or
`<name>-2.md`, `<name>-3.md` and so on when that exists, with an exclusive
create, so two agents asking at the same moment never get the same page.
The skill tells agents to write only pages they claimed and to wait with
their page's path, so they never write into each other's pages or wake on
each other's answers. A person can still write a page file directly. A name
that has submits in the log stays taken after its page is deleted, so a new
page never inherits the answers of an old one.

`whiteboard wait` and `watch` hand out each event once, without the agent keeping
track: handing an event out appends a `whiteboard:picked` event naming it,
so the log is the only record of what was handed out. Each command first
returns the matching events nobody picked up, also those from before it
started, whatever filter handed out the others; then it follows the log, and
gets every new matching event, also when another running wait gets it too.
The backlog and the following split the log at one byte offset, so no event
falls between them.

Relative links and images in any rendered markdown are resolved from that
file's own folder on disk and rewritten to the URL that serves the target
(a page or a repository file; `name` also finds `name.md`), so links between
documents work the way they do in the repository. A link that points nowhere
is left as written.

## Core (`src/`)

The core reads a stored page, picks its renderer and hands the page over,
on the server and in the browser.

### Stored pages

What a renderer gets is the page as stored (`StoredPage` in `src/define.ts`):

| kind | what | served at |
| --- | --- | --- |
| `page` | a markdown file: `source`, and its `frontmatter` fields | `/<page>`, `/-/<path>.md` |
| `file` | any other text file of the repository: `source` | `/-/<path>` |
| `folder` | a repository folder: its `entries` | `/-/<path>/` |
| `pages` | the overview, or a folder of pages without an `index.md`: the `pages` in it, with when each was last answered | `/`, `/<folder>/` |

Images and other binary files are served as they are.

### Renderers

```ts
interface Renderer {
  name: string
  render?(page: StoredPage, ctx: RenderContext): { html, title?, head?, data? }   // server
  client?: URL                         // browser: default export mount(root, page, api)
  docs?(ctx): string                   // markdown: how to write pages for it
  expects?(page, ctx): string[]        // the event types the page waits on the reader for: its questions
}
```

- **Which one.** The config lists the renderers; the first is the default.
  A page picks another in its frontmatter (`renderer: slides`). With none,
  or when the one a page names is missing, the page shows as its raw text,
  with a note saying why.
- **Server.** `render` returns the page's first HTML, put into
  `<div id="wb-root">`, its `<head>` additions and `data` for the client.
  `ctx.asset(file)` gives the URL a file is served at (a client module, a
  stylesheet); only files asked for this way are served, from `/_/file/…`.
  `ctx.urlFor(file)` gives the URL that shows a file or folder on disk, for
  links.
- **Browser.** The core's runtime (`src/client/runtime.ts`) imports the
  renderer's `client` and calls `mount(root, page, api)`. `page` has the
  page's id, kind and `data`, `onChange(fn)`, `render()` (the server render,
  afresh) and `stored()` (the stored page, afresh). `api` has the page's
  events, `onEvents`, `last(type)` and `append(type, data, action)`, the
  listeners, and three things the page's parts share: `rendered()` (a
  renderer that patched its content says so, and plugins listening with
  `onRendered` put back what they add to it), `corner()` (an empty column at
  the bottom right, the one element the core puts on every page, for
  floating buttons) and `badge(key, text, order)` with `title(title)` (counts
  in the tab title, in front of the page's own title).
- **Changes.** The core only signals that a page changed; the renderer
  fetches what it needs. That keeps how an update looks the renderer's
  choice: markboard morphs it in place.

### Plugins

Behaviour on every page, whatever renderer draws it (`Plugin` in
`src/define.ts`): an object in the config's `plugins`, with a name and
optional parts. Its routes are mounted at `/api/<name>/…`, its commands are
`whiteboard <name> [sub]`, its files go in `.whiteboard/<name>/`, and
`shell(req)` adds markup to every page. The core checks a route's token and
arguments before its code runs.

- **One contract, portable parts inside.** The object is the only thing the
  core knows. Inside it, a behaviour is built from pieces with no whiteboard
  in them where it can be: the terminal's server half is a plain request
  handler and its host a process of its own, so taking it elsewhere means
  dropping the ten lines that wire them in.
- **In the browser.** `client` is a module the runtime imports after the
  renderer has mounted, with the same `mount(root, page, api)` arguments.
  A plugin that works on the page's content puts back what it adds
  after `api.onRendered`; a renderer that patches its content keeps the
  `data-wb-*` attributes a plugin set (markboard does). Floating
  buttons go in `api.corner()` and counts in the title through
  `api.badge()`, so a renderer and plugins never need to know about each
  other.
- **A plugin owns a whole feature.** Its event types, what it draws
  and what it tells agents, end to end, so taking it out of the config
  removes the feature and breaks nothing else: the terminal, the Claude
  Code hooks, comments. A behaviour that is half a core protocol and half
  a renderer's look is neither: named forms are the core's protocol, and
  how they look is the renderer's.
- **Renderers stay their own kind.** A renderer is chosen (one per page:
  the first, or the one the page names), a plugin is added (all of
  them, on every page). One list of plugins would not remove that choice,
  only turn it into a rule about the list, so the config keeps saying
  plainly what renders and what is added. The two already share their
  shape where it overlaps: a name, a `client` with the same `mount`, and
  `docs()`. When a renderer needs routes, commands or a folder of its own,
  it gets `setup` and `commands` the way a plugin does; until one does,
  that stays unbuilt.

### Comments (`comments/`)

A plugin too, so any page can be commented on. Selecting text in the
page's content (its `<main>`, else all of it) shows a "Comment" button; a
comment is an event (`comment`, with the quote and the text around it),
and so are replies (`comment-reply`) and closing a thread
(`comment-resolve`). Passages are found again by quote and context after
edits, and highlighted with the CSS Highlight API, so the page's markup
never changes for them. A badge in the margin opens each open thread; it
is filled when the agent spoke last. How an agent answers is in its
`docs()`, which `whiteboard docs` prints after the renderers': an
plugin can document what it sends to the log.

### Named forms

Whiteboard's one interaction primitive, so the core's, on every page
whatever renderer drew it (`src/client/forms.ts`). It draws nothing; how
it looks is the renderer's.

- **Submits.** A `<form name="…">` without an `action` attribute (one with
  an action submits normally) is a question. Submitting it appends an
  event: its name as `type`, the button as `action`, the fields as `data`.
  `data-wb-state` says how sending went (sending, sent, failed).
- **Drafts and the last answer.** What the reader types is kept in
  localStorage until it is sent, so it survives a re-render and a reload;
  the last answer goes back into the form, its button in `data-wb-sent`. A
  form marked `data-wb-self` (or inside an element that is) keeps its own
  fields, for a renderer's component that shows them itself.
- **Where each stands.** Every form gets one of four attributes, from the
  log and the listeners: `data-wb-waiting` when a listener asks for it by
  name (also when it was answered before: the agent wants a new answer) or
  takes any answer and it has none; `data-wb-unheard` when it has no answer
  and nobody listens; `data-wb-pending` when it is answered but no `wait`
  or `watch` handed the answer out (the core marks such events `pickedUp`,
  from the `whiteboard:picked` events in the log); `data-wb-decided` once
  one did, with `data-wb-outcome` quoting the answer in one line. The
  states are marked again when the log, the listeners or the page change,
  and `api.forms()` / `api.onForms()` give them to the renderer, for
  drawing more than the attributes allow.
- **Which forms a page asks** is the renderer's (`expects`): only it can
  read its own syntax.

An earlier version made this a plugin. It held half of a core
protocol and half of markboard's look, so it was split between the two.

### Events

The core appends `{ id, ts, page, type, action, data }` to
`.whiteboard/events.ndjson` when the browser calls `api.append`. A form's
submit is one: its `type` is the form's name, `action` the button that sent
it. `whiteboard wait` and `watch` filter by page and type, and hand out each
event once (see Projects): `watch` is `wait` that never exits.

Events the command line appends (`whiteboard append`, an agent's reply,
say) carry `from: "cli"`; waits skip them, so an agent never wakes on its
own events, and renderers can tell the two sides apart.

Only one server runs per project, also when several commands want one at
the same moment: the one that creates `server.lock` starts it and the others
wait for it, and a server that finds another of its project already up
exits.

### Listeners

While `whiteboard wait` or `watch` runs, it holds a connection to the
server's `/api/listen` with its filter: that connection is a listener, and
it is gone when the command is (it reconnects when the server restarts). The
server tells pages when listeners come and go (`listeners` on the live
channel), and `api.listeners()` gives the ones covering the page. So what an
agent waits for is a fact the command line knows, not something the agent
has to mark; renderers show it as they like. Reading the log never depends
on the connection, so no answer is missed while the server is away.

### Status and hooks

What is open is a fact the core can state without asking the agent, so the
agent forgetting a wait is caught from outside it:

- **Questions.** A question exists only in a renderer's syntax (for markboard,
  a named form), so the renderer says which a page asks: `expects(page)`
  returns their event types. A question is open while no event of its type
  came from the reader.
- **Claims.** `whiteboard new` appends a `whiteboard:claim` event with the
  agent session that made the page; the colon keeps it apart from form
  names. Which session runs a command is something only the agent's tooling
  knows, so the core asks the project's plugins (`session()`), and
  records no claim when none names one.
- **Status.** `/api/status` and `whiteboard status` give, per page: its open
  questions, those no listener covers (unheard), the reader's events no wait
  or watch picked up, its listeners and its claim.
- **Hooks.** Reporting the status to an agent is a plugin, since how is
  particular to each agent, and the core has no agent-specific code. The
  Claude Code plugin (`claude-code/`) names the session from
  `CLAUDE_CODE_SESSION_ID`, and adds `whiteboard claude-code hook
  stop|prompt|session`, which Claude Code runs (`whiteboard claude-code
  install` adds them). None blocks. `stop` shows the reader what on the
  session's pages nobody listens for. `prompt` and `session` give the agent,
  as context, the answers on its pages nobody picked up, and count them as
  picked up (a `whiteboard:picked` event each); `session` also lists what is
  open on other sessions' pages, without handing it over. A plugin's
  command gets the status and the pick-up from the core (`ctx.status()`,
  `ctx.pickUp()`).

### Loading and reloading

The config is loaded by Node itself, which runs its TypeScript
(`src/load.js`). Two resolve hooks help it: `@bigmistqke/whiteboard/*`
always means the engine's own build, so a project needs no `node_modules`;
and the config and the local files it imports get a version in their URL,
so a change loads them afresh. Nothing compiles browser code: a renderer's
or template's browser module is served as the file it is, so packages ship
JavaScript.

The browser listens at `/api/watch`: `change` (its page changed), `events`
(the log grew), `style` (a stylesheet changed: reloaded in place) and
`reload` (browser code changed: the page reloads). The config, `.whiteboard/`
and the folders of served files are watched; any other change in them loads
the config afresh and re-renders open pages.

## markboard (`markboard/`)

The renderer that ships with whiteboard: pages are markdown, extended by
templates.

1. Turns markdown into HTML: remark (GFM + `remark-directive`), then rehype.
   Raw HTML passes through, so `<details>` and hand-written forms work.
   Frontmatter is skipped. Code blocks that no template handles render as
   plain `<pre><code>`, unless there is a code template (below).
2. Resolves extension points to templates:
   - `:::name[label]{attrs}` … `:::` container directives, `::name[label]{attrs}`
     leaf directives, `:name[label]{attrs}` text directives
   - ```` ```name attrs ```` fences
3. Draws the frame: breadcrumbs, when the page was updated, the theme
   toggle (light, dark or the system's) and the live indicator; the overview
   (the pages, then every markdown document in the project), folder listings
   with their README on top, and repository files as code. Its HTML is built
   with `html` tagged templates (`markboard/html.js`), which escape every
   value unless it is marked as HTML (`raw()`, for markdown's output); the
   comment popover in the browser uses the same.
4. Patches the page in place when it changes, with morphdom: focus, caret,
   typed values, open `<details>` (found by their heading and summary, so a
   block added above one keeps it open), the reader's place on the page,
   and mounted islands whose props did not change all survive (islands
   carry a `data-wb-key` hashed from template + props), and so do the
   `data-wb-*` marks set in the browser (the core's form states).
   - **New content.** A top-level block whose content was not on the page
     the last time the reader saw it gets a red bar on its left. It counts as
     seen after it has been at least half in view for 0.6s with the tab
     visible, then the bar fades. What was seen is kept per page in
     localStorage, so reopening a page later also shows what changed. A
     page opened for the first time marks nothing, and neither does one
     where fewer than a quarter of the blocks are left from the last visit:
     it is effectively a new page, and marking all of it says nothing.
     Content inside a `[data-wb-quiet]` element (the `quiet` template
     writes one) does not count: it can appear, change or go without
     marking its block, and a block that is quiet as a whole is never
     marked. It is for what changes without being news to the reader.
   - **Navigator.** Floating `↑ new (n)` / `↓ new (n)` buttons in the
     page's corner jump to the nearest unseen block; the tab title gets a
     `(n)` badge.
5. Leaves comments to the comments plugin, which works on its
   `<main>`.
6. Writes forms as markdown (the `form` template); sending them and
   drafts are the core's. The template adds a
   thread under each form:
   messages are `thread` events (`{ form, text }`, from the reader or the
   agent), never submits, so asking about a choice never makes it. An agent
   message can name the submit whose typed text it answers (`replyTo`),
   shown as the reader's message before it, and can take the place of an
   earlier one (`replaces`), since the log only grows.
7. Shows what waits on whom, from the core's form states: a form waiting
   for the reader is outlined and says so, one nobody listens for says
   that, a decided one folds into one line quoting its answer (a click
   opens it again to change it). A line above the page counts the four
   states and jumps through each, a button in the page's corner jumps from
   one waiting form to the next, the tab title gets a `(!n)` badge, and the
   overview marks the pages an agent waits on.

Nested containers may all use `:::`. markboard pairs the fences and lengthens
the outer ones before parsing, because remark-directive needs an outer fence
to be longer than the ones inside it.

### Templates

```ts
// <repo>/.whiteboard/config.ts
import { defineConfig } from '@bigmistqke/whiteboard/config'
import markboard from '@bigmistqke/whiteboard/markboard'
import chart from 'whiteboard-chart'   // a template package of someone else's
import timeline from './templates/timeline.ts'

export default defineConfig({
  name: 'radio-garden',
  renderers: [markboard({ templates: [chart({ palette: 'cool' }), timeline] })],
})
```

A template handles the directive and fence with its `name`
(`:::name`, `::name`, `:name`, ```` ```name ````). markboard's own templates are
always there; one passed with the same name replaces it.

```ts
export default {
  name: 'chart',
  props: ctx => ({ … }),     // server: JSON props for the client (optional)
  html: ctx => '…',          // server: the block's HTML; with a client, shown until it mounts (optional)
  client: new URL('./client.js', import.meta.url),   // browser: default export mount(el, props, api) (optional)
  style: new URL('./style.css', import.meta.url),    // linked on pages that use it (optional)
  readme: new URL('./README.md', import.meta.url),   // syntax and examples (optional)
} satisfies Template
```

- Types come from `@bigmistqke/whiteboard/template` (`Template`, `Mount`,
  `ClientApi`, the server context types). `defineTemplate` only returns its
  argument; a published package needs no runtime import from whiteboard.
- Files are referenced by URL relative to the module, so they resolve
  wherever the package is installed.
- The server context has `attrs`, `label`, `children` (mdast),
  `sections()`, `toHtml(nodes)`, `markdown(src)`, `inline(src)`, `page`,
  `file`, `dir` and more.
- Without `props`, a directive client gets
  `{ name, attrs, label, html, intro, sections: [{ title, text, html }] }`
  (`sections` splits the content at its shallowest headings, or at blank
  lines when there are none); a fence client gets `{ name, attrs, text }`.
- A template with only `html` is static: no JavaScript on the page.
- `code: true` makes a template the one for code blocks in general: it also
  gets every fence no template claims by name, and the code view of
  repository files, with the fence's language in `ctx.lang`. Highlighting is
  a template for the same reason a diagram is: themes and colours are a
  choice. The last `code` template wins. Without one, code renders plain, which is still a valid page.
- Layout classes a template can put on its outermost element: `.wb-figure`
  runs up to `--figure` (920px) wide, like a standalone image or a diagram;
  `.wb-wide` runs up to `--wide` (1040px), like a grid of cards. Both centre
  on the text column and stay within the screen.
- A client's island is wrapped in `<div class="wb-island" data-template="name">`.
  markboard never adds `wb-<name>` classes, so a template owns its class names.
- `api` (a `ClientApi`) is the core's `Api` (the page id, its events with a
  subscription, `last(type)`, `append(type, data)`) plus markboard's theme, with
  a subscription too. `@bigmistqke/whiteboard/solid` wraps it:
  `export default solid(Component)` and `useWhiteboard()` for signals.
- A client is one module the browser loads as it is, so a package bundles
  what its client needs, UI framework included. `markboard()`'s Solid clients
  each carry their own copy of Solid; the cost is some bytes over a local
  connection, and in return a client needs nothing from the page.


Template files are watched like any served file: a changed client reloads
the open pages (drafts keep what was typed), a changed style reloads in
place, anything else (server functions, readmes) loads the config afresh
and re-renders.

## Layout

```
src/              the core; ./config (and the types of ./client)
src/client/       the core in the browser
bin/whiteboard.js the `whiteboard` command
markboard/            ./markboard: the markboard renderer and its templates; ./template: their contract
markboard/client/     markboard in the browser: morphing, islands, forms, new-content marks, theme
solid/            ./solid: write template clients as Solid 2 components
build.js          builds dist/: what the package ships as JavaScript (`npm run dev` watches)
skills/whiteboard the agent skill: where to write pages, how to wait for input
.whiteboard/      this repository as a whiteboard project (dogfooding)
```

It is one package, `@bigmistqke/whiteboard`, with a subpath export per part;
it splits into packages once a second renderer exists. The core never
imports markboard; a config does. The server resolves the package's own exports
itself, so a config in a repository without npm can import
`@bigmistqke/whiteboard/markboard`.

Node runs TypeScript, but not inside `node_modules`, where an installed
package lives; so what a project imports from this one ships built in
`dist/`. The engine's own server code is plain JavaScript and runs as it is.

## Files

- `<repo>/.whiteboard/`: a project (see Projects). There are no other files.
- `$WHITEBOARD_PORT` (default 4777): the port a project's server tries first.
