# whiteboard — design

A whiteboard for a person and an agent: when something is too much for text
in a terminal, the agent writes a page and the person reads it live in a
browser. Pages can hold forms; submitting one appends an event to a log the
agent waits on, so both sides write on the board. The terminal stays for
conversation; the page holds overview, detail and decisions.

## Principles

- **Markdown, read as stored.** A page is stored as text and the core reads
  it as it is. The core renders it as markdown, with the blocks the
  project's plugins bring. It used to hand pages to renderers, of which
  markdown with templates was one; no second renderer was ever written, and
  three kinds of extension (renderers, templates, plugins) made every
  feature ask which kind it was. So there is one: plugins. Rendering stays
  behind one internal interface (`src/pages/`), so another way to show
  pages could come back without a public concept for it.
- **A small core.** The core keeps pages, renders them as markdown, keeps
  the event log and the live channel between them and a browser. It
  compiles nothing and depends on no UI framework; anything a page shows
  beyond markdown is a plugin's block.
- **No agent concepts in the core.** There are no tasks, statuses or
  approvals. The one interaction primitive is appending an event to a page's
  log: a submitted form is one, a plugin can append others. Everything else
  is a plugin or a convention between an agent and its pages.
- **Everything added is a module.** Plugins are objects (usually returned
  by a factory taking options) that a config imports from a package or a
  local file, the way bundler plugins work.
- **Agent-written pages must never break.** An unknown directive renders as
  its content, an unknown fence as a code block, a block that throws as an
  error box in place of that block only. A config that fails to load leaves
  pages as their raw text, with the error above it.
- **Self-documenting.** The core says how pages are written and which
  plugin brings which block; each plugin documents its blocks, its events,
  commands and routes. All of it is served at `/_/docs` and printed by
  `whiteboard docs` (`whiteboard docs <name>` for one plugin), so agents read
  the current syntax instead of remembering it.

## Projects

A project is a folder (usually a repository) with a `.whiteboard/` folder.
Everything whiteboard keeps is in that `.whiteboard/` folder; nothing lives
outside the project:

```
<repo>/.whiteboard/
  config.ts     optional: defineConfig({ name, plugins, style, files }), only what differs
  pages/        the project's pages, served at /<page>
  events.ndjson the project's events: form submits, threads, comments, and what agents picked up
  token         the secret for what runs code (the terminal)
  server.json   the port and process of the project's running server
  server.log    that server's output
  .gitignore    everything but config.ts: remove a line to keep it in git
```

`whiteboard init` creates it. Every command works on the project of the
current folder: the nearest folder upward with a `.whiteboard/` folder.
Without a config the project has the defaults: the built-in plugins and
the folder's name. `init` writes a config only for what differs (a name, or
`files: false` in the home folder); the config is looked up on every load,
so one added or removed while the server runs counts at once. Outside a
project the commands stop and point to `whiteboard init`. An agent working
in the repository can start the server, write pages and read answers without
access outside it.

**Security: whiteboard runs with the rights of whoever started it, and
adds none.** The server runs code from the project: it imports `config.ts`
and the local plugins that imports, and its plugins run more (the terminal
runs a program). An agent can write all of that, since it is in the
project, and the project's token is in the project too: it keeps other
websites out, not agents. So the boundary is wherever the server was
started, set from outside, where an agent can't change it. Start the server
inside the sandbox the agents run in (an agent starting it with `whiteboard
show` does), and everything it starts is boxed in the same way; then an
agent driving the terminal or editing the config can do nothing it couldn't
already do. A server started outside that sandbox lets an agent reach past
it, through the config alone. No setting in the project can be the boundary,
because an agent can change the project.

Each project runs its own server. `whiteboard show` starts it in the
background when it is not running: it takes the port it had last time, else
4777 (`$WHITEBOARD_PORT`), else the next free one, and records it in
`server.json`. The command line checks that the server on that port is this
project's before using it. Two projects open at once are two servers on two
ports; nothing coordinates them, and `/` lists only this project's pages.

Any other file in the project folder is served from the repository at
`/-/<path>`: markdown files as pages, folders with their entries, other text
files as code, all rendered like any page; images and other binary files
are served as they are. `.git` is never served. The whole project folder is
watched so these views stay live.

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
The backlog and the following split the log at one line boundary, so no
event falls between them, not even one being written as the command starts.

This is handing out (`handOut` in `src/events.ts`), and it is built only
from the log's primitives: read the log (to the end of its last whole
line), follow it from an offset, append to it, and record a pick. Each
primitive is a command too (`events`, `events --follow`, `append`, `pick`)
and a module (`@bigmistqke/whiteboard/log`), so an agent or a script can use
the log in a way whiteboard doesn't offer, such as picking an answer up only
once it has acted on it, without writing a plugin. A plugin's command hands
out through `ctx.handOut`, the same function.

Relative links and images in any rendered markdown are resolved from that
file's own folder on disk and rewritten to the URL that serves the target
(a page or a repository file; `name` also finds `name.md`), so links between
documents work the way they do in the repository. A link that points nowhere
is left as written.

## Core (`src/`)

The core reads a stored page, renders it as markdown with the plugins'
blocks, and runs it in the browser with the plugins' modules.

### Stored pages

What the core reads is the page as stored (`StoredPage` in `src/define.ts`):

| kind | what | served at |
| --- | --- | --- |
| `page` | a markdown file: `source`, its `body` (without frontmatter) and its `frontmatter` fields | `/<page>`, `/-/<path>.md` |
| `file` | any other text file of the repository: `source` | `/-/<path>` |
| `folder` | a repository folder: its `entries` | `/-/<path>/` |
| `pages` | the overview, or a folder of pages without an `index.md`: the `pages` in it, with when each was last answered | `/`, `/<folder>/` |

Images and other binary files are served as they are.

### Showing a page

- **One seam.** The server renders through one interface, made by the
  config loader for each loaded config (`createPages` in
  `src/pages/index.ts`): `render(page, ctx)` gives a stored page's HTML, its
  title, its `<head>` additions and `data` for the browser; `docs(ctx)` says
  how pages are written and which plugin brings which block; `questions(page)`
  gives the event types a page waits on the reader for. The server knows
  nothing else of markdown. It is internal, not a public concept: it is
  where another way to show pages would plug in, should one come back.
- **Server.** The render goes into `<div id="wb-root">`. `ctx.asset(file)`
  gives the URL a file is served at (a client module, a stylesheet); only
  files asked for this way are served, from `/_/file/…`. `ctx.urlFor(file)`
  gives the URL that shows a file or folder on disk, for links.
- **Browser.** The core's runtime (`src/client/runtime.ts`) imports the page
  module (`src/client/page/main.ts`) and calls `mount(root, page, api)`.
  `page` has the page's id, kind and `data`, `onChange(fn)`, `render()` (the
  server render, afresh) and `stored()` (the stored page, afresh). `api` has
  the page's events, `onEvents`, `last(type)` and `append(type, data,
  action)`, the listeners, and three things the page's parts share:
  `rendered()` (the page module says it patched its content, and plugins
  listening with `onRendered` put back what they add to it), `corner()` (an
  empty column at the bottom right, the one element the core puts on every
  page, for floating buttons) and `badge(key, text, order)` with
  `title(title)` (counts in the tab title, in front of the page's own
  title). Then the runtime starts the named forms and imports the plugins'
  modules, with the same arguments.
- **Changes.** The core only signals that a page changed; the page module
  fetches the new render and morphs it in place.
- **When the config fails.** There are no pages to render with, so the
  server shows the page as stored, as text, under the error, and the
  runtime runs no page module: it replaces the text when the page changes.
  A render that throws falls back the same way.

### Plugins

Everything that extends whiteboard (`Plugin` in `src/define.ts`): an
object in the config's `plugins`, with a name and optional parts, all under
that name, so two plugins can't collide:

- `blocks`: syntax for pages, by name (see Blocks). Block names are unique
  across a project's plugins: two plugins bringing the same one is a config
  error.
- `events`: the event types it writes, `<plugin>:<what>`, each with a
  `description` and whether it is handed out (see Events). The loader
  checks the names.
- `style`: a stylesheet linked on every page.
- `links({ dir })`: text that links somewhere as written (`#12` → an issue):
  a pattern, where a match links to and its hover text. The core applies them
  to plain text when it parses a page, never inside code, links or inline
  directives (a button's label), so a plugin needs no hook into the markdown
  pipeline. Asked once per project folder, so it can read the project (the
  forge plugin reads the `origin` remote: `#n` issues and `!n` pull or merge
  requests on GitHub or GitLab; links only, nothing is fetched).
- `docs()`: markdown for whoever writes pages, printed by `whiteboard docs`
  under a `# Plugin: <name>` heading the core adds, with its events,
  commands and routes listed after it.
- `commands`: `whiteboard <name> [sub]`, with declared options the core
  parses and checks. A command gets the project, the log, the token, the
  server, the status (`ctx.status()`) and handing out (`ctx.handOut()`).
- `session()`: the agent session a command runs in (see Status and hooks).
- `setup(ctx)`, run once per loaded config on the server: its `routes` are
  mounted at `/api/<name>/…` (the core checks a route's token and arguments
  before its code runs), `shell(req)` adds markup to every page's `<head>`
  and `<body>`, and `client` is a module on every page. Its files go in
  `.whiteboard/<name>/`.

The built-in plugins are in `plugins/<name>/`: callout, chat, code,
comments, details, form (with its input blocks), gallery, grid, mermaid and
quiet. Every project has them (`builtins()` in `plugins/index.ts`); a
config's `plugins` add to them, and one with a built-in's name replaces it
in its place, so options are given by replacing (`code({ themes })`, from
`@bigmistqke/whiteboard/code`). The terminal (`/terminal`) and the Claude
Code plugin (`/claude-code`) are opt-in, since they run code or are about
one agent. The loader imports the built-ins afresh with every load of the
config, like what a config imports itself.

- **One kind of extension.** A block, a behaviour on every page, a command
  and an event type are all parts of a plugin, so a feature that needs
  several (the chat: a block, its event, its docs) is one object, and a
  config has one list.
- **One contract, portable parts inside.** The object is the only thing the
  core knows. Inside it, a behaviour is built from pieces with no whiteboard
  in them where it can be: the terminal's server half is a plain request
  handler and its host a process of its own, so taking it elsewhere means
  dropping the ten lines that wire them in.
- **In the browser.** `setup`'s `client` is a module the runtime imports
  after the page module has mounted, with the same `mount(root, page, api)`
  arguments. A plugin that works on the page's content puts back what it
  adds after `api.onRendered`; the page module keeps the `data-wb-*`
  attributes a plugin set when it morphs. Floating buttons go in
  `api.corner()` and counts in the title through `api.badge()`, so the page
  and plugins never need to know about each other.
- **A plugin owns a whole feature.** Its event types, what it draws
  and what it tells agents, end to end, so taking it out of the config
  removes the feature and breaks nothing else: the terminal, the Claude
  Code hooks, comments. A behaviour that is half a core protocol and half
  a page's look is neither: named forms are the core's protocol, and how
  they look is the page's.

### Comments (`plugins/comments/`)

A plugin too, so any page can be commented on. Selecting text in the
page's content (its `<main>`, else all of it) shows a "Comment" button; a
comment is an event (`comments:new`, with the quote and the text around
it), and so are replies (`comments:reply`) and closing a thread
(`comments:resolve`). Passages are found again by quote and context after
edits, and highlighted with the CSS Highlight API, so the page's markup
never changes for them. A badge in the margin opens each open thread; it
is filled when the agent spoke last, and has a dot while a reply in it is
unread. How an agent answers is in its
`docs()`, which `whiteboard docs` prints with the other plugins': a plugin
documents what it sends to the log.

### Named forms

Whiteboard's one interaction primitive, so the core's, on every page
(`src/client/forms.ts`). It draws nothing; how it looks is the page's
(`src/client/page/`).

- **Submits.** A `<form name="…">` without an `action` attribute (one with
  an action submits normally) is a question. Submitting it appends an
  event: its name as `type`, the button as `action`, the fields as `data`.
  `data-wb-state` says how sending went (sending, sent, failed).
- **Drafts and the last answer.** What the reader types is kept in
  localStorage until it is sent, so it survives a re-render and a reload;
  the last answer goes back into the form, its button in `data-wb-sent`. A
  form marked `data-wb-self` (or inside an element that is) keeps its own
  fields, for a block's client that shows them itself.
- **Where each stands.** Every form gets one of three attributes, from the
  log: `data-wb-open` when it has no answer, or when a listener asks for it
  by name after its answer was picked up (the agent wants a new answer);
  `data-wb-pending` when it is answered but no `wait` or `watch` handed the
  answer out (the core marks such events `pickedUp`, from the
  `whiteboard:picked` events in the log); `data-wb-decided` once one did,
  with `data-wb-outcome` quoting the answer in one line. The states are
  marked again when the log, the listeners or the page change, and
  `api.forms()` / `api.onForms()` give them to the page and plugins, for
  drawing more than the attributes allow.
- **Open means it waits for the reader,** whether or not an agent listens.
  An earlier version marked a form "waiting for you" only while a wait
  covered it, and "nobody listening" otherwise: that told the reader about
  the agent's process, not about their to-do, and a catch-all watch made
  every question look urgent. Whether an agent listens is told where it
  helps when something goes wrong: the toast after a submit, and
  `whiteboard status` (`unheard`).
- **Which forms a page asks** is read from its markdown (`questions`):
  `:::form{name=…}` blocks and hand-written `<form name>` without an action,
  parsed, so a form shown as an example in a code block doesn't count.

An earlier version made this a plugin. It held half of a core
protocol and half of the page's look, so it was split between the two.

### Events

The core appends `{ id, ts, page, type, action, data }` to
`.whiteboard/events.ndjson` when the browser calls `api.append`. A form's
submit is one: its `type` is the form's name, `action` the button that sent
it. `whiteboard wait` and `watch` filter by page and type, and hand out each
event once (see Projects): `watch` is `wait` that never exits.

Events the command line appends (`whiteboard append`, an agent's reply,
say) carry `from: "cli"`; waits skip them, so an agent never wakes on its
own events, and the page and plugins can tell the two sides apart.

Event types share one namespace, so a colon is reserved: a form's name
has none, and every other type is named after its owner, `<owner>:<what>`.
That is whiteboard itself (`whiteboard:claim`, `whiteboard:picked`) or a
plugin (`chat:message`, `comments:new`, `comments:reply`,
`comments:resolve`), so a form's answers never mix with their events.
A form whose name has a colon is not a question: the form block shows
an error in its place, and the core leaves it alone.

Which agent events are messages for the reader is stated the same way:
`forReader: true` (of the built-ins, `comments:reply` and `chat:message`).
One from the agent waits for the reader until read. The page marks the
element showing a message with `data-wb-message="<event id>"`; once it has
been mostly in view while the tab is visible, the core appends a
`whiteboard:read` event naming it (several at once, a moment later).
Reading is in the log, not the browser, so it holds in every browser, the
server counts unread messages on every page (the header, the overview),
and an agent can see what was read. A message the agent replaced
(`replaces`) no longer counts, and closing a comment thread reads its
replies.

A message (a comment, a reply, a chat message) is markdown, rendered by the
server like a page (`/api/markdown`, `api.markdown` in the browser: batched,
cached), so code fences are highlighted and text links work as on a page,
without a second markdown parser in the browser. A message is no page: its
raw HTML is text and its directives show as written, so a comment can't put
a form or a script on the page. Until the server answers, it shows as its
plain text.

Which events reach an agent unasked is stated, not guessed. A form's
answers (types without a colon) always do. Of a plugin's events, only
those it declares `handOut: true` do (`forAgent` in `src/events.ts`): a
`wait` or `watch` on the page hands them out, `ctx.handOut` in a plugin's
command does, `whiteboard status` counts them, and so the Claude Code
hooks deliver them. The others stay in the log, for `whiteboard events` or
a `wait --type` that asks for them by name. Of the built-ins,
`chat:message`, `comments:new` and `comments:reply` are handed out;
`comments:resolve` is not: the reader closing a thread asks nothing of the
agent.

Only one server runs per project, also when several commands want one at
the same moment: the one that creates `server.lock` starts it and the others
wait for it, and a server that finds another of its project already up
exits.

The server itself is a request handler you create for a project
(`createServer(project)` in `src/server.ts`): nothing happens on import,
and its state (listeners, open pages, watchers) lives in it, so tests make
one for a throwaway project and send it requests (`src/server.test.ts`).
Listening on a port, `server.json` and the lock are `src/serve.ts`, and
finding a project's running server is `src/running.ts`, shared with the
command line.

### Listeners

While `whiteboard wait` or `watch` runs, it holds a connection to the
server's `/api/listen` with its filter: that connection is a listener, and
it is gone when the command is (it reconnects when the server restarts). The
server tells pages when listeners come and go (`listeners` on the live
channel), and `api.listeners()` gives the ones covering the page. So what an
agent waits for is a fact the command line knows, not something the agent
has to mark. The page shows it in one place, small, for when something seems
off: the dot at the end of its header is green while it is live and a wait
or watch covers it (its own, or the project-wide one), grey while live with
nobody listening, and a ring while it is not connected; its title says
which.

A `wait` or `watch` without `--page` is the project's fallback: it takes
only what no other listener would take, by page and type, on any page,
also answers left from sessions that ended, and an event another listener
would have taken once that one stops. It asks no question again. One runs
per project: the server refuses a second (`409`), which exits 1. Without
this, a page-less listener competed with every page's own agent and was
rarely what anyone meant. Reading the log never depends on the
connection, so no answer is missed while the server is away.

### Status and hooks

What is open is a fact the core can state without asking the agent, so the
agent forgetting a wait is caught from outside it:

- **Questions.** A question is a named form, so the pages say which a page
  asks: `questions(page)` returns their event types. Where each stands
  (open, pending, decided; see Named forms) is one function,
  `questionState` in `src/status.ts`, which the server and the page both
  use, so `whiteboard status` and the page never disagree. A question is
  open while it waits for the reader: it has no answer, or a running wait
  asks for it by name (the agent wants a new answer). Only the reader's
  events answer it.
- **Claims.** `whiteboard new` appends a `whiteboard:claim` event with the
  agent session that made the page; the colon keeps it apart from form
  names. Which session runs a command is something only the agent's tooling
  knows, so the core asks the project's plugins (`session()`), and
  records no claim when none names one.
- **Status.** `/api/status` and `whiteboard status` give, per page: its open
  questions, those no listener covers (unheard), the agent's messages the
  reader hasn't read, the reader's events for an agent (see Events) no wait
  or watch picked up, its listeners and its claim. What waits for the
  reader on a page (`awaiting`) is its open questions and unread messages.
- **Hooks.** Reporting the status to an agent is a plugin, since how is
  particular to each agent, and the core has no agent-specific code. The
  Claude Code plugin (`plugins/claude-code/`) names the session from
  `CLAUDE_CODE_SESSION_ID`, and adds `whiteboard claude-code hook
  stop|prompt|session`, which Claude Code runs (`whiteboard claude-code
  install` adds them). None blocks. `stop` shows the reader what on the
  session's pages nobody listens for. `prompt` and `session` give the agent,
  as context, the answers on its pages nobody picked up, and count them as
  picked up (a `whiteboard:picked` event each); `session` also lists what is
  open on other sessions' pages, without handing it over. A plugin's
  command gets the status and handing out from the core (`ctx.status()`,
  `ctx.handOut()`); the hooks hand out only the session's own pages, not
  the pages below them, which can be another session's.

### Loading and reloading

The config is loaded by Node itself, which runs its TypeScript
(`src/load.ts`); `src/loader.ts` makes of it the project's plugins (the
built-ins, then the config's), checks them, and makes the pages from their
blocks. Two resolve hooks help Node: `@bigmistqke/whiteboard/*` always means
the engine's own files (its source, or its build once installed; see
Layout), so a project needs no `node_modules`; and the config and the local
files it imports get a version in their URL, so a change loads them afresh.
Nothing compiles browser code: a plugin's or block's browser module is
served as the file it is, so packages ship JavaScript.

The browser listens at `/api/watch`: `change` (its page changed), `events`
(the log grew), `style` (a stylesheet changed: reloaded in place) and
`reload` (browser code changed: the page reloads). The config, `.whiteboard/`
and the folders of served files are watched; any other change in them loads
the config afresh and re-renders open pages.

## Pages (`src/pages/`, `src/client/page/`)

How the core shows a page. On the server, the markdown engine
(`src/pages/`: `markdown.ts`, `render.ts`, `blocks.ts`) behind the one
interface above; in the browser, the page module (`src/client/page/`).

1. Turns markdown into HTML: remark (GFM + `remark-directive`), then rehype.
   Raw HTML passes through, so `<details>` and hand-written forms work.
   Frontmatter is skipped. Code blocks that no block handles render as
   plain `<pre><code>`, unless a block takes every fence (`fence: 'any'`,
   the built-in `code`).
2. Hands extension points to the plugins' blocks:
   - `:::name[label]{attrs}` … `:::` container directives, `::name[label]{attrs}`
     leaf directives, `:name[label]{attrs}` text directives
   - ```` ```name attrs ```` fences
3. Draws the frame: breadcrumbs, when the page was updated, the theme
   toggle (light, dark or the system's) and the live indicator; the overview
   (the pages, then every markdown document in the project), folder listings
   with their README on top, and repository files as code. Its HTML is built
   with `html` tagged templates (`src/html.ts`), which escape every
   value unless it is marked as HTML (`raw()`, for markdown's output); the
   comment popover in the browser uses the same. Stylesheets are linked in
   this order: the page's own (`base.css`), every plugin's `style`, the
   `style` of each block used on the page, then the config's `style`.
4. Patches the page in place when it changes, with morphdom: focus, caret,
   typed values, open `<details>` (found by their heading and summary, so a
   block added above one keeps it open), the reader's place on the page,
   and mounted islands whose props did not change all survive (islands
   carry a `data-wb-key` hashed from block + props), and so do the
   `data-wb-*` marks set in the browser (the core's form states).
   - **New content.** A top-level block whose content was not on the page
     the last time the reader saw it gets a red bar on its left. It counts as
     seen after it has been at least half in view for 0.6s with the tab
     visible, then the bar fades. What was seen is kept per page in
     localStorage, so reopening a page later also shows what changed. A
     page opened for the first time marks nothing, and neither does one
     where fewer than a quarter of the blocks are left from the last visit:
     it is effectively a new page, and marking all of it says nothing.
     Content inside a `[data-wb-quiet]` element (the `quiet` block writes
     one) does not count: it can appear, change or go without marking its
     block, and a block that is quiet as a whole is never marked. It is for
     what changes without being news to the reader.
   - **Navigator.** Floating `↑ new (n)` / `↓ new (n)` buttons in the
     page's corner jump to the nearest unseen block; the tab title gets a
     `(n)` badge.
5. Leaves comments to the comments plugin, which works on its `<main>`.
6. Forms are written as markdown with the `form` plugin's blocks; sending
   them and drafts are the core's. Chats are the `chat` plugin: a chat
   under each form, named after it, and `:::chat{name=…}` blocks anywhere.
   Messages are `chat:message` events (`{ chat, text }`, from the reader or
   the agent), never submits, so asking about a choice never makes it. An
   agent message can take the place of an earlier one (`replaces`), since
   the log only grows, and in a form's chat can name the submit whose typed
   text it answers (`replyTo`), shown as the reader's message before it. A
   chat no longer on the page (its form or block removed or renamed) is
   listed after the page's content, read-only, until one of its name is
   back (`src/client/page/orphans.ts`).
7. Shows what waits for the reader: open questions and unread messages. An
   open form is outlined and says "waiting for you", a decided one folds
   into one line quoting its answer, with its thread still open under it (a
   click on the line opens the form again to change it). A line above the
   page counts the states and unread messages and jumps through each, a
   button in the page's corner goes from one thing waiting to the next (a
   message not shown, such as a reply in a closed thread, is found by the
   element holding it, `data-wb-holds`, which is sent `wb-reveal` to show
   it), unread messages get a toast that stays, the tab title gets a
   `(!n)` badge, and the header and the overview mark the other pages with
   something waiting.

Containers are parsed as written: a `:::` closes the first open container
whose fence is no longer than its own, so a container around another needs
more colons (`::::grid` around `:::details`).

## Blocks

A plugin's `blocks` are its syntax: each handles the directive and fence
with its name (`:::name`, `::name`, `:name`, ```` ```name ````).

```ts
// .whiteboard/config.ts
import { defineConfig } from '@bigmistqke/whiteboard'
import chart from 'whiteboard-chart'   // a plugin package of someone else's
import timeline from './plugins/timeline/index.ts'

export default defineConfig({
  name: 'radio-garden',
  plugins: [chart({ palette: 'cool' }), timeline()],
})
```

```ts
export default () => definePlugin({
  name: 'chart',
  blocks: {
    chart: {
      props: ctx => ({ … }),     // server: JSON props for the client (optional)
      html: ctx => '…',          // server: the block's HTML; with a client, shown until it mounts (optional)
      client: new URL('./client.js', import.meta.url),   // browser: default export mount(el, props, api) (optional)
      style: new URL('./style.css', import.meta.url),    // linked on pages that use it (optional)
    },
  },
  docs: () => '…',               // syntax and examples, for `whiteboard docs` (optional)
})
```

- The contract is in `src/define.ts` and exported from
  `@bigmistqke/whiteboard`: `Block`, `defineBlock`, `Mount`, the server
  context types (`ServerContext`, `DirectiveContext`, `FenceContext`,
  `Section`), the default props (`DirectiveProps`, `FenceProps`),
  `ClientApi` and `Theme`, with `html`, `raw` and `escape`.
  `definePlugin` and `defineBlock` only return their argument; a published
  package needs no runtime import from whiteboard.
- Files are referenced by URL relative to the module, so they resolve
  wherever the package is installed.
- The server context has `attrs`, `label`, `children` (mdast),
  `sections()`, `toHtml(nodes)`, `markdown(src)`, `inline(src)`, `page`,
  `file`, `dir` and more.
- Without `props`, a directive client gets
  `{ name, attrs, label, html, intro, sections: [{ title, text, html }] }`
  (`sections` splits the content at its shallowest headings, or at blank
  lines when there are none); a fence client gets `{ name, attrs, text }`.
- A block with only `html` is static: no JavaScript on the page.
- A block gets the code fences of its name (```` ```mermaid ````) only when
  it says so, `fence: true`. Without that, a fence of its name is code like
  any other: ```` ```text ```` is code, not the form's text field of the
  same name. (An earlier version handed every fence to the block of its
  name, and code in a `text` fence came out as an empty input.)
- `fence: 'any'` makes a block the one for code in general: it also gets
  every fence no block claims by name, and the code view of repository
  files, with the fence's language in `ctx.lang`. Highlighting is a block
  for the same reason a diagram is: themes and colours are a choice. When
  several set it, the last plugin's wins. Without one, code renders plain,
  which is still a valid page.
- Layout classes a block can put on its outermost element: `.wb-figure`
  runs up to `--figure` (920px) wide, like a standalone image or a diagram;
  `.wb-wide` runs up to `--wide` (1040px), like a grid of cards. Both centre
  on the text column and stay within the screen.
- A client's island is wrapped in `<div class="wb-island" data-block="name">`.
  The engine never adds `wb-<name>` classes, so a block owns its class names.
- `api` (a `ClientApi`) is the core's `Api` (the page id, its events with a
  subscription, `last(type)`, `append(type, data)`) plus the page's theme,
  with a subscription too. `@bigmistqke/whiteboard/solid` wraps it:
  `export default solid(Component)` and `useWhiteboard()` for signals.
- A client is one module the browser loads as it is, so a package bundles
  what its client needs, UI framework included. The built-in Solid clients
  (chat, gallery) each carry their own copy of Solid; the cost is some
  bytes over a local connection, and in return a client needs nothing from
  the page.
- A plugin's `docs` say how to write its blocks; there is no readme per
  block. The built-ins keep theirs in a `README.md` beside the plugin.

Block files are watched like any served file: a changed client reloads
the open pages (drafts keep what was typed), a changed style reloads in
place, anything else (server functions, docs) loads the config afresh
and re-renders.

## Layout

```
src/              the core; the package's own entry (`@bigmistqke/whiteboard`: the contract and its types)
src/pages/        the markdown engine behind one interface: markdown.ts, render.ts, blocks.ts
src/client/       the core in the browser: the runtime, named forms
src/client/page/  the page in the browser: morphing, islands, new-content marks, theme, waiting and folding, orphaned chats
src/loader.ts     the config loader: the plugins, checked, and the pages made from their blocks
plugins/<name>/   the built-in plugins (./plugins), and the opt-in ones: terminal, claude-code
bin/              the `whiteboard` command
solid/            ./solid: write block clients as Solid 2 components
build.ts          builds dist/: what the package ships as JavaScript (`npm run dev` watches)
skills/whiteboard the agent skill: where to write pages, how to wait for input
.whiteboard/      this repository as a whiteboard project (dogfooding)
```

It is one package, `@bigmistqke/whiteboard`, with a subpath export per
part: `.`, `./log`, `./plugins`, `./code`, `./comments`, `./terminal`,
`./claude-code` and `./solid`. The server resolves the package's own
exports itself, so a config in a repository without npm can import
`@bigmistqke/whiteboard/terminal`.

Everything is TypeScript, written so that Node can run it by stripping
its types (`erasableSyntaxOnly`: no enums, no namespaces), and `npm run
check` type-checks all of it; `npm test` runs the unit tests
(`node:test`, next to the code as `*.test.ts`), and `npm run test:browser`
runs forms, comments and the terminal in a browser (Playwright, in
`test/browser/`), each in a throwaway project with its own server. Node runs TypeScript, but not inside
`node_modules`, where an installed package lives; so everything the package
runs ships built in `dist/`, the engine and its plugins included, and its
`exports` and its `bin` point there. To work on whiteboard without
building, run `bin/whiteboard.ts` instead (link `whiteboard` to it): Node
runs it from source, and everything on the server follows, so a change
needs no build. Each export has a `source` condition (listed first,
pointing at the TypeScript) that the config loader picks when the engine
itself runs from source, as does `tsc` (`customConditions`); a build run
uses the build throughout, so the two never mix.
This is the usual way to run a TypeScript package from source during
development; the condition stays in the published `package.json`, where
nothing asks for it. Only browser code is always built (`npm run dev`), so
the page module and the plugins find their browser modules in `dist/`
(`builtFile`), from source and from the build alike.
Paths into the package are found from its root (`src/package.ts`), since a
module in `dist/` sits at another depth than its source.

## Files

- `<repo>/.whiteboard/`: a project (see Projects). There are no other files.
- `$WHITEBOARD_PORT` (default 4777): the port a project's server tries first.
