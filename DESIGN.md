# visualize — design

Markdown pages that agents write and people read in a browser. Pages can hold
forms; submitting one appends a line to an ndjson log that agents watch. The
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
  the page. Solid is supported through the `@visualize/solid` adapter.
- **No agent concepts in the engine.** There are no tasks, statuses or
  approvals. The engine has one interaction primitive: submitting a named
  HTML form. Everything else is a template, or a convention between an agent
  and its pages.
- **Agent-written markdown must never break a page.** An unknown directive
  renders its content as plain markdown; an unknown fence renders as a code
  block; a template that throws renders an error box in place of that block
  only; a broken config shows its error above the page.
- **Templates document themselves.** Each template's readme is its syntax
  reference, served at `/_/docs` and printed by `visualize docs`, so agents
  read the current syntax instead of remembering it.

## Projects

A project is a folder (usually a repository) with a `.visualize/` folder:

```
<repo>/.visualize/
  config.ts     defineConfig({ name, templates: [...] })
  pages/        the project's pages, served at /<name>/…  (gitignored by default)
  style.css     optional, applied to the project's pages
  .gitignore    "pages/": remove the line to keep pages in git
```

Any other file in the project folder is served from the repository at
`/<name>/-/<path>`: markdown renders like a page (templates, live reload,
forms), folders list their files with their README on top, other text files
show as code, and images are served as they are. `.git` is never served.

Relative links and images in any rendered markdown are resolved from that
file's own folder on disk and rewritten to the URL that serves the target
(a page, a repository file, or a file in the shared folder; `name` also
finds `name.md`), so links between documents work the way they do in the
repository. A link that points nowhere is left as written.

`visualize init` creates it. Agents working in the repository write pages
there, so they need no access outside the repository. One server serves every
project: `<root>/projects.json` maps names to folders, and every CLI command
run inside a project refreshes its entry, so a cloned or moved repository
registers itself. `/` lists every project's pages.

## Engine (`packages/engine`)

1. Turns markdown into HTML: remark (GFM + `remark-directive`), then rehype.
   Raw HTML passes through, so `<details>` and hand-written forms work.
   Code blocks that no template handles are highlighted on the server with
   Shiki; each token carries a light and a dark colour as CSS variables, so
   highlighting follows the theme without scripts.
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
   `data-vz-key` hashed from template + props).
   - **New content.** A top-level block whose content was not on the page
     the last time the reader saw it gets a red bar on its left. It counts as
     seen after it has been at least half in view for 0.6s with the tab
     visible, then the bar fades. What was seen is kept per page in
     localStorage, so reopening a page later also shows what changed.
   - **Navigator.** Floating `↑ new (n)` / `↓ new (n)` buttons jump to the
     nearest unseen block; the tab title gets a `(n)` prefix.
5. Appends `{ id, ts, page, form, action, data }` to `events.ndjson` when a
   `<form name="…">` without an `action` attribute is submitted. `action` is
   the value of the button that submitted it.

Nested containers may all use `:::`. The engine pairs the fences and lengthens
the outer ones before parsing, because remark-directive needs an outer fence
to be longer than the ones inside it.

## Templates

```ts
// <repo>/.visualize/config.ts
import { defineConfig } from '@visualize/engine/config'
import basic from '@visualize/templates-basic'
import chart from 'visualize-chart'
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

- Types come from `@visualize/engine/template` (`Template`, `Mount`,
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
- Layout classes a template can put on its outermost element: `.vz-figure`
  runs up to `--figure` (920px) wide, like a standalone image or a diagram;
  `.vz-wide` runs up to `--wide` (1040px), like a grid of cards. Both centre
  on the text column and stay within the screen.
- A client's island is wrapped in `<div class="vz-island" data-template="name">`.
  The engine never adds `vz-<name>` classes, so a template owns its class names.
- `api` (a `ClientApi`) gives the page id, the page's form submissions and the
  theme, each with a subscription. `@visualize/solid` wraps it:
  `export default solid(Component)` and `useVisualize()` for signals.
- Packages keep their UI framework as a peer dependency; the engine's Vite
  dedupes `solid-js` and `@solidjs/web` so all Solid templates on a page share
  one copy.

### Which templates apply

The global config (`<root>/config.ts`, optional) applies to every page; a
project's config adds to it, replacing templates with the same name. Within a
config, later entries replace earlier ones.

Configs and template sources are watched: editing a client hot-reloads it,
editing a style reloads stylesheets in place, editing anything else (config,
server functions, readmes) re-renders open pages.

## Layout

```
packages/engine           the engine and the `visualize` CLI
packages/solid            @visualize/solid: write template clients as Solid 2 components
packages/templates-basic  grid, gallery, details, callout, form, mermaid: basic()
skills/visualize          the agent skill: where to write pages, how to wait for input
.visualize/               this repository as a visualize project (dogfooding)
```

## Files

- `<repo>/.visualize/`: a project (see Projects).
- `$VISUALIZE_DIR` (default `~/.visualize`): the shared folder.
  - `projects.json`: project name → folder.
  - `events.ndjson`: one JSON event per line, append-only, for every project.
  - `config.ts`: optional global config.
  - `style.css`: optional, overrides the base page style everywhere.
  - Markdown files here are served too (`foo/bar.md` at `/foo/bar`), for
    pages outside any project.
- `$VISUALIZE_PORT` (default 4777).
