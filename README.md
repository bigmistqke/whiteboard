# whiteboard

A whiteboard for you and your agent.

Some things are too much for text in a terminal: a plan with open questions,
a comparison, the state of a long-running task. With whiteboard the agent
writes them as a markdown page, and you read the page live in your browser
next to the conversation. Every save updates the open page, and what changed
is marked until you've seen it. When the agent needs something from you, it
puts a form on the page. Your answer goes into a log the agent is waiting on.

It stays small: markdown files, one server per project, and one way to
interact (submitting a form). Everything else, from cards and diagrams to a
canvas you could sketch on together, is a template.

## Install

In the repository you work in:

```sh
npm i -D @bigmistqke/whiteboard
npx whiteboard init                # creates .whiteboard/ with a config and a pages folder
```

Then give your agent the skill that tells it how to use the whiteboard
([below](#the-agent-skill)).

Requires Node 22 or later.

<details>
<summary>Without npm in the repository, or for every project at once</summary>

Install the command globally instead and run it as `whiteboard`:

```sh
npm i -g @bigmistqke/whiteboard
whiteboard init
```

A project needs no `node_modules` of its own: the server resolves the
package's imports in `.whiteboard/config.ts` itself, so a Rust or Go
repository can have a whiteboard too.

</details>

## Quick start

Write a page:

````sh
cat > .whiteboard/pages/plan.md <<'EOF'
# Release plan

:::grid{cols=2}
### Parser {done}
Rewritten, all tests pass.

### Docs {todo}
Not started.
:::

```form ship
Ship it this week?
radio: when | When | *this week, next week
submit: Decide
```
EOF
npx whiteboard show plan           # starts the server, prints http://localhost:4777/plan
````

Open the URL, then wait for the answer in another terminal:

```sh
npx whiteboard wait --page plan --form ship
# {"id":"…","ts":"…","page":"plan","form":"ship","action":"Decide","data":{"when":"this week"}}
```

That round trip is the whole idea. In practice the agent writes the page and
runs `wait`; you read and answer.

## How it works

A project is a folder with a `.whiteboard/` folder in it. Everything
whiteboard keeps is there; nothing is written outside the project.

```
.whiteboard/
  config.ts       templates and options
  pages/          the pages: pages/plan.md is served at /plan
  style.css       optional, extra styles for the pages
  events.ndjson   every form submit, one JSON object per line
  server.json     the port and process of the running server
  server.log      that server's output
```

Pages, the event log and the server files are gitignored by default.

- **One server per project.** `whiteboard show` starts the project's server
  when it isn't running. It takes the port it had last time, else 4777 (or
  `$WHITEBOARD_PORT`), else the next free one.
- **Live pages.** Every save of a page updates the open tab in place. Blocks
  that changed get a marker until you've seen them, and buttons jump to the
  next unseen block.
- **Repository files render too.** `/-/README.md` shows that file as a page,
  `/-/src/` lists a folder, and other text files show as highlighted code.
  Relative links between documents work the way they do in the repository.
- **Markdown never breaks a page.** An unknown template renders its content
  as plain markdown, and a template that throws shows an error in place of
  that block only.

## Forms and answers

A form with a `name` and no `action` attribute is recorded when submitted:

```json
{"id":"…","ts":"2026-…","page":"plan","form":"ship","action":"Decide","data":{"when":"this week"}}
```

`action` is the button that was pressed and `data` holds the fields. The
`form` template (in `basic()`) writes forms from a short syntax; a
hand-written `<form name="…">` works without it.

Reading answers:

```sh
whiteboard wait --page plan --form ship     # blocks until the next submit, prints it
whiteboard watch --page plan                # streams submits, never exits
whiteboard events --page plan --last 1      # what was already submitted
```

## Commands

Every command works on the project of the current folder: the nearest folder
upward with `.whiteboard/config.ts`.

| command | does |
| --- | --- |
| `whiteboard init [name]` | make this folder a project |
| `whiteboard root` | print the folder pages go into |
| `whiteboard show <page\|file>` | start the server if needed, print the page's URL |
| `whiteboard url <page\|file>` | the same |
| `whiteboard docs [template…]` | print the syntax of the project's templates |
| `whiteboard templates` | list the project's templates |
| `whiteboard events [filters]` | print recorded submits |
| `whiteboard wait [filters]` | block until the next matching submit, print it |
| `whiteboard watch [filters]` | print matching submits as they arrive |
| `whiteboard serve` | run the server in the foreground |
| `whiteboard skill [dir]` | print where the agent skill is, or link it into a skills folder |

Filters: `--page <page|file>` (includes pages below it), `--form <name>`.
`wait` also takes `--timeout <seconds>` (exits 2 on timeout) and `--count <n>`;
`events` takes `--since <time or event id>` and `--last <n>`.

## Configuration

```ts
// .whiteboard/config.ts
import { defineConfig } from '@bigmistqke/whiteboard/config'
import basic from '@bigmistqke/whiteboard/basic'

export default defineConfig({
  name: 'my-project',   // shown in titles (default: the folder name)
  templates: [basic()], // later entries replace earlier ones with the same name
  files: true,          // serve and watch the rest of the project at /-/ (default: true)
})
```

Set `files: false` for a project whose folder is not a repository, such as
your home folder. Then only `.whiteboard/` is served and watched.
`whiteboard init` sets it when run in the home folder.

## Templates

Templates turn parts of a page into something richer. A template handles a
container `:::name`, a line `::name`, inline `:name`, or a fenced block
```` ```name ````. `basic()` ships with the package:

| template | for |
| --- | --- |
| `grid` | cards in a grid, with status badges |
| `gallery` | images with a lightbox |
| `details` | a collapsible section |
| `callout` | a highlighted note, tip or warning |
| `form` | forms from a short syntax |
| `mermaid` | Mermaid diagrams, rendered on the server |
| `code` | syntax highlighting for code blocks (Shiki) |

The full syntax, with live examples, is at `/_/docs` on the running server
and printed by `whiteboard docs`. The agent reads it from there, so it
always matches the templates the project actually has.

`basic()` takes options for the code highlighter:

```ts
basic({ code: { themes: { light: 'github-light', dark: 'github-dark' } } })
```

### Writing a template

A template is an object. It can render HTML on the server, run a component
in the browser, or both:

```ts
// .whiteboard/templates/timeline.ts
import type { Template } from '@bigmistqke/whiteboard/template'

export default {
  name: 'timeline',
  html: ctx => `<ol class="timeline">…</ol>`,             // server: the block's HTML
  client: new URL('./timeline.tsx', import.meta.url),     // browser: default export mount(el, props, api)
  style: new URL('./timeline.css', import.meta.url),      // linked on pages that use it
  readme: new URL('./timeline.md', import.meta.url),      // its syntax, shown by `whiteboard docs`
} satisfies Template
```

Add it to `templates` in the config. Browser code can be written in any
framework; `@bigmistqke/whiteboard/solid` turns a Solid component into a
client. A template with `code: true` also renders every code block no other
template claims. See [DESIGN.md](https://github.com/bigmistqke/whiteboard/blob/main/DESIGN.md#templates)
for the full contract.

The package ships TypeScript sources. They run through whiteboard's own Vite,
so there's no build step for you, but they aren't meant to be imported
outside a whiteboard config.

## The agent skill

The package includes a skill: instructions that teach an agent where pages
go, how to write them, and how to wait for answers. It is a folder with a
`SKILL.md`, the format several coding agents read.

```sh
npx whiteboard skill                      # prints where the skill folder is
npx whiteboard skill ~/.claude/skills     # links it into Claude Code's skills folder
```

Link it into whichever folder your agent reads skills from. The link points
into the installed package, so the skill updates when you update whiteboard.
Agents that don't read skills can be pointed at the `SKILL.md` file directly.

## Design

[DESIGN.md](https://github.com/bigmistqke/whiteboard/blob/main/DESIGN.md)
records how whiteboard works and why: the principles, the engine, the
template contract and the page client.

## License

MIT
