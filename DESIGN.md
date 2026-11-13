# whiteboard — design

A whiteboard for a person and an agent: when something is too much for text
in a terminal, the agent writes a markdown page and the person reads it live
in a browser. Pages can hold forms; submitting one appends a line to an
ndjson log that the agent waits on, so both sides write on the board. The
terminal stays for conversation; the page holds overview, detail and
decisions.

## Principles

- **The engine knows no templates.** Galleries, cards, forms-from-shorthand,
  diagrams: all of it is templates that a config imports. The engine ships
  with none and loads none by default.
- **Templates are modules.** A template is an object (usually returned by a
  factory taking options) that a config file imports from a package or a
  local file, the way Vite plugins work. Packages can be built and published
  like any other npm package.
- **Framework-agnostic.** A template's browser code exports
  `mount(element, props, api)`; the engine never imports a UI framework into
  the page. Solid is supported through the `@bigmistqke/whiteboard/solid` adapter.
- **No agent concepts in the engine.** There are no tasks, statuses or
  approvals. The engine has one interaction primitive: submitting a named
  HTML form. Everything else is a template, or a convention between an agent
  and its pages.
- **Agent-written markdown must never break a page.** An unknown directive
  renders its content as plain markdown; an unknown fence renders as a code
  block; a template that throws renders an error box in place of that block
  only; a broken config shows its error above the page.
- **Templates document themselves.** Each template's readme is its syntax
  reference, served at `/_/docs` and printed by `whiteboard docs`, so agents
  read the current syntax instead of remembering it.

## Projects

A project is a folder (usually a repository) with a `.whiteboard/config.ts`.
Everything whiteboard keeps is in that `.whiteboard/` folder; nothing lives
outside the project:

```
<repo>/.whiteboard/
  config.ts     defineConfig({ name, templates: [...], files })
  pages/        the project's pages, served at /<page>
  style.css     optional, applied to the project's pages
  events.ndjson the project's form submits
  server.json   the port and process of the project's running server
  server.log    that server's output
  .gitignore    everything but config.ts and style.css: remove a line to keep it in git
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
`/-/<path>`: markdown renders like a page (templates, live reload, forms),
folders list their files with their README on top, other text files show as
code, and images are served as they are. `.git` is never served. The whole
project folder is watched so these views stay live.

`files: false` in the config turns that off: only `.whiteboard/` is served and
watched. It is for a project whose folder is not a repository, such as the
home folder, where serving every file would expose it and watching every file
would be slow. `whiteboard init` sets it when run in the home folder; a
project at `~` is also how to have pages for folders that have no project of
their own, since commands find the nearest project upward. A config that
fails to load serves no files either.

Relative links and images in any rendered markdown are resolved from that
file's own folder on disk and rewritten to the URL that serves the target
(a page or a repository file; `name` also finds `name.md`), so links between
documents work the way they do in the repository. A link that points nowhere
is left as written.

## Engine (`src/`)

1. Turns markdown into HTML: remark (GFM + `remark-directive`), then rehype.
   Raw HTML passes through, so `<details>` and hand-written forms work.
   Code blocks that no template handles render as plain `<pre><code>`, unless
   the config has a code template (below).
2. Resolves extension points to templates:
   - `:::name[label]{attrs}` … `:::` container directives, `::name[label]{attrs}`
     leaf directives, `:name[label]{attrs}` text directives
   - ```` ```name attrs ```` fences
3. Loads config files and compiles template client modules with Vite
   (middleware mode), with HMR. The Solid compiler is included so local
   `.tsx` templates need no build step; pre-built packages need none at all.
4. Live-reloads a page when its markdown file changes, patching it in place
   with morphdom: focus, caret, typed values, open `<details>` and mounted
   islands whose props did not change all survive (islands carry a
   `data-wb-key` hashed from template + props).
   - **New content.** A top-level block whose content was not on the page
     the last time the reader saw it gets a red bar on its left. It counts as
     seen after it has been at least half in view for 0.6s with the tab
     visible, then the bar fades. What was seen is kept per page in
     localStorage, so reopening a page later also shows what changed. A
     page opened for the first time marks nothing, and neither does one
     where fewer than a quarter of the blocks are left from the last visit:
     it is effectively a new page, and marking all of it says nothing.
   - **Navigator.** Floating `↑ new (n)` / `↓ new (n)` buttons jump to the
     nearest unseen block; the tab title gets a `(n)` prefix.
5. Appends `{ id, ts, page, form, action, data }` to the page's
   `events.ndjson` when a `<form name="…">` without an `action` attribute is
   submitted. `action` is the value of the button that submitted it. The log
   is the project's own `.whiteboard/events.ndjson`.

Nested containers may all use `:::`. The engine pairs the fences and lengthens
the outer ones before parsing, because remark-directive needs an outer fence
to be longer than the ones inside it.

## Templates

```ts
// <repo>/.whiteboard/config.ts
import { defineConfig } from '@bigmistqke/whiteboard/config'
import basic from '@bigmistqke/whiteboard/basic'
import chart from 'whiteboard-chart'   // a template package of someone else's
import timeline from './templates/timeline'

export default defineConfig({
  name: 'radio-garden',
  templates: [basic(), chart({ palette: 'cool' }), timeline],
})
```

A template handles the directive and fence with its `name`
(`:::name`, `::name`, `:name`, ```` ```name ````):

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
  `ClientApi`, the server context types). `defineConfig`/`defineTemplate`
  only return their argument; a published package needs no runtime import
  from the engine.
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
  choice, and the engine makes none. The last `code` template in config
  order wins. Without one, code renders plain, which is still a valid page.
- Layout classes a template can put on its outermost element: `.wb-figure`
  runs up to `--figure` (920px) wide, like a standalone image or a diagram;
  `.wb-wide` runs up to `--wide` (1040px), like a grid of cards. Both centre
  on the text column and stay within the screen.
- A client's island is wrapped in `<div class="wb-island" data-template="name">`.
  The engine never adds `wb-<name>` classes, so a template owns its class names.
- `api` (a `ClientApi`) gives the page id, the page's form submissions and the
  theme, each with a subscription. `@bigmistqke/whiteboard/solid` wraps it:
  `export default solid(Component)` and `useWhiteboard()` for signals.
- Packages keep their UI framework as a peer dependency; the engine's Vite
  dedupes `solid-js` and `@solidjs/web` so all Solid templates on a page share
  one copy.

### Which templates apply

The project's config is the only one. Within it, later entries replace
earlier ones with the same name.

Configs and template sources are watched: editing a client hot-reloads it,
editing a style reloads stylesheets in place, editing anything else (config,
server functions, readmes) re-renders open pages.

## Layout

```
src/              the engine; ./config, ./template and ./client of the package
bin/whiteboard.js the `whiteboard` command
basic/            ./basic: grid, gallery, details, callout, form, mermaid, code: basic()
solid/            ./solid: write template clients as Solid 2 components
skills/whiteboard the agent skill: where to write pages, how to wait for input
.whiteboard/      this repository as a whiteboard project (dogfooding)
```

It is one package, `@bigmistqke/whiteboard`, with a subpath export per part.
The engine still imports no templates; a config does. The server resolves the
package's own exports itself, so a project needs no `node_modules` to use
them: a config in a repository without npm can import
`@bigmistqke/whiteboard/basic`.

## Files

- `<repo>/.whiteboard/`: a project (see Projects). There are no other files.
- `$WHITEBOARD_PORT` (default 4777): the port a project's server tries first.
