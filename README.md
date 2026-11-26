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
terminal at the bottom of the page, is a plugin.

## Install

In the repository you work in:

```sh
npm i -D @bigmistqke/whiteboard
npx whiteboard init                # creates .whiteboard/ with a pages folder
```

Then give your agent the skill that tells it how to use the whiteboard
([below](#the-agent-skill)).

Requires Node 22.18 or later (it runs the TypeScript config itself).

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
### Parser :badge[done]
Rewritten, all tests pass.

### Docs :badge[todo]
Not started.
:::

:::form{name=ship}
Ship it this week? :radio[this week]{name=when} :radio[next week]{name=when}

:button[Decide]
:::
EOF
npx whiteboard show plan           # starts the server, prints http://localhost:4777/plan
````

Open the URL, then wait for the answer in another terminal:

```sh
npx whiteboard wait --page plan --type ship
# {"id":"…","ts":"…","page":"plan","type":"ship","action":"Decide","data":{"when":"this week"}}
```

That round trip is the whole idea. In practice the agent writes the page and
runs `wait`; you read and answer.

Agents claim their pages with `whiteboard new <name>`, which creates the file
under a name no other page has: `plan`, else `plan-2`, and so on. Several
agents can work in one project without writing into each other's pages or
waking on each other's answers.

## How it works

A project is a folder with a `.whiteboard/` folder in it. Everything whiteboard keeps of a project is there; outside a project it
writes only the shared server's state, when you run one
([below](#many-projects-one-server)).

```
.whiteboard/
  config.ts       optional: what differs from the defaults (plugins, a stylesheet, options)
  pages/          the pages: pages/plan.md is served at /plan
  events.ndjson   the events, one JSON object per line: form submits, comments, replies,
                  and which ones an agent received and handled
  token           the secret for what runs code (the terminal)
  server.json     the port and process of the running server
  server.log      that server's output
```

Pages, the event log and the server files are gitignored by default.

- **One server per project,** or one for many ([below](#many-projects-one-server)).
  `whiteboard show` starts the project's server when it isn't running. It
  takes the port it had last time, else 4777 (or `$WHITEBOARD_PORT`), else
  the next free one.
- **Markdown, extended by plugins.** A page is markdown, and plugins add
  blocks to it: `:::form`, `:::grid`, `:::chat`, ```` ```mermaid ```` and
  the rest are built-in plugins, and a project can add its own.
- **Live pages.** Every save of a page updates the open tab in place, and
  blocks that changed are marked until you've seen them.
- **Repository files render too.** `/-/README.md` shows that file as a page,
  `/-/src/` lists a folder, and other text files show as highlighted code.
  Relative links between documents work the way they do in the repository.
- **Markdown never breaks a page.** A block nobody brings renders its
  content as plain markdown, and one that throws shows an error in place of
  that block only. A config that fails to load leaves pages as their raw
  text, with the error above it.

## Many projects, one server

With many checkouts at once (git worktrees, job folders), one server per
project means one port per project, and no place that shows them all. A
machine config gathers them under one server instead:

```json
// ~/.config/whiteboard/config.json  ($XDG_CONFIG_HOME/whiteboard, or $WHITEBOARD_HOME)
{
  "port": 4777,
  "entries": {
    "rg": {
      "include": ["~/rg/develop", "~/rg/develop/.claude/worktrees/*", "~/rg/worksite/jobs/*"],
      "exclude": ["~/rg/worksite/archive/**"]
    }
  }
}
```

Every folder an include matches, that no exclude matches and that has a
`.whiteboard/` folder, is a project of that entry. It is served at
`/<entry>/<path>/`, where `<path>` is the include's last plain folder and what
its wildcards matched: `/rg/develop/`, `/rg/worktrees/cmux/`,
`/rg/jobs/2026-11-19-solid-port/`. A second folder that would get the same path
gets `-2`. The server looks for projects again every few seconds, so a new
worktree with a `.whiteboard/` shows up, and a removed one goes, without a
restart.

- **`/` is the overview of every project,** as a project's own overview is of
  its pages, and it looks and updates the same: each project under its name
    (`develop`, `worktrees › cmux`), its pages as its overview lists them, with
  the inbox badge on those waiting for you, and its documents folded under them by folder, under its folder. Projects with something waiting
  come first, and in each the pages waiting; projects without pages are folded
  at the end, under the server's version and the folders it is boxed to.
- **Every page's menu of what waits elsewhere** (the inbox in its header)
  lists the other projects of its entry too, under each project's name.
- **Commands work as before,** in the project's folder: `show`, `url`,
  `wait`, `append`, `events`, `status` act on their own project and find the
  shared server. Events stay in each project's own `.whiteboard/events.ndjson`.
  A project outside every include runs its own server, as without the config.
- **The fallback covers the whole entry.** A `wait` or `watch` without
  `--page` in a project of an entry takes what no other wait or watch in any
  of the entry's projects would take, from each project's own log, and says
  where each answer is from (`project`, its folder, and the page's `url`). So
  an agent overseeing the others runs `whiteboard watch` once, and an answer
  on a page whose agent stopped listening still reaches it. One runs per
  entry; a second exits 1.
- **Commands never start the shared server.** `show` without it says so; a
  `wait` waits for it to appear, and the answers in the log reach it either
  way; `status` and `docs` answer without it. A project outside every include
  still starts its own, with `show`.
- **You start it, outside the agents' sandboxes:** `whiteboard serve` outside
  any project, in a terminal or as a login service. It runs every project's
  config and plugins (the terminal runs programs), so it can do whatever any
  of them can; started from inside one agent's sandbox, it would be boxed in
  there and miss the other folders. Box it on its own instead, with a
  wrapper of your own, as you may do for your agent: `whiteboard paths
  --write` and `--read` print what it needs (`:` between folders), so the
  box follows the config:
  ```sh
  safehouse --workdir= --add-dirs="$(whiteboard paths --write)" \
    --add-dirs-ro="$(whiteboard paths --read)" \
    -- WHITEBOARD_SANDBOX="$(whiteboard paths --write)" whiteboard serve
  ```
  `$WHITEBOARD_SANDBOX`, when set, is what the overview says it is boxed to.
  The server writes only its state folder (`~/.local/state/whiteboard`:
  `server.json`, its log, the overview's project) and reads the config, so
  nothing running inside it can change how it is served or boxed next time.
  See [DESIGN.md](DESIGN.md#entries-one-server-for-many-projects).
- **Versions.** The server records its version (in `server.json` in its state
  folder, and in the overview). `serve` from a newer whiteboard takes an older
  server over: it asks it to exit and starts in its place. A command from a
  newer whiteboard uses an older server and says to restart it; an older one
  never replaces a newer one.
- **A project per checkout.** A folder is a project once it has a
  `.whiteboard/`: have whatever makes worktrees and job folders run
  `whiteboard init` in each, and every one appears on the index by itself, its
  pages and answers its own.

## Forms and answers

A form with a `name` and no `action` attribute is recorded when submitted:

```json
{"id":"…","ts":"2026-…","page":"plan","type":"ship","action":"Decide","data":{"when":"this week"}}
```

`type` is the form's name, `action` is the button that was pressed and
`data` holds the fields. The log is an event stream: a plugin can append
events of other types too, through `api.append(type, data)`. Those types
are named after their plugin, `<plugin>:<what>` (`chat:message`,
`comments:reply`, whiteboard's own `whiteboard:handled`), so a form's name
can't contain a colon and its answers never mix with them. Appending is
optimistic: the event is in `api.events()` at once, with `sending: true`
until the server has it, so show it then as on its way, not as done: in
`--wb-sending` (grey), as the core does for a form's button and the chat
for a message. A send that heard nothing back is tried again, without being
appended twice; only when none gets through does the event leave the
events again and the promise `api.append` returned reject. The built-in
`form` plugin writes forms as markdown with inputs inline
(`:::form{name=ship}` … `:radio[this week]{name=when}` … `:::`); a
hand-written `<form name="…">` works without it.

A plugin says which of its events are for an agent (`handOut: true`): chat
messages and comments are, so a `wait` on the page hands them out like
answers. Others, such as a vote, stay in the log, for `whiteboard events`
or a `wait --type` that asks for them.

Reading answers:

```sh
whiteboard wait --page plan --type ship     # the next answer to that form
whiteboard watch --page plan                # streams submits, never exits
whiteboard events --page plan --last 1      # what was already submitted
```

`wait` never loses an answer. An answer goes through three states: *not
received* (no agent has it yet), *received* (an agent has it: a wait printed
it, `whiteboard:received` in the log, so no other wait takes it too) and
*handled* (the agent is done with it: it replied in its chat or thread, or ran
`whiteboard handled <id>`, `whiteboard:handled` in the log). A log from 0.10
or older, with `whiteboard:taken` and `whiteboard:picked`, is converted once,
the first time it is read. A wait prints every answer on its page not
handled yet, including ones given before it started and ones handed out
before (marked `"again": true`), so an answer an agent saw and forgot comes
back. So an agent can ask, do other work, and wait later. One wait or watch
holds a page; a second is refused unless `--force`, which stops the first.

`wait` is built from smaller pieces that are commands too, for a script that
wants to use the log its own way:

```sh
whiteboard events --follow --page plan      # every new event as it comes, marking nothing
whiteboard handled <event id>               # the agent is done with it
whiteboard append --page plan --type <t>    # write one
```

The same pieces are a module, `@bigmistqke/whiteboard/log`: `read`,
`follow`, `appendEvent`, `receive`, `handle`, and `handOut`, which is `wait` itself.

## A terminal on every page

The terminal is a plugin: add it to the config.

```ts
import terminal from '@bigmistqke/whiteboard/terminal'

export default defineConfig({
  plugins: [terminal()],
})
```

`whiteboard terminal` prints a link that unlocks a terminal drawer at the
bottom of every page of the project, in that browser. Collapsed it's a bar;
open, it shows a terminal with tabs. Each tab is a session in a
pseudo-terminal, in a small host process of its own that the server starts.
So the sessions outlive the browser tab (switching pages, reloading or
opening a second browser tab shows the same ones) and the server: a
restarted server finds them where they were. The browser morphs the drawer
from one page into the next (a view transition across the page load), and
the server writes the current screens into each page, so it never shows
empty. Ctrl+\` opens and closes it.

Several browser windows can show the same tab. A tab has one size, the
size of the window you used last (opened the drawer, clicked or typed in
it); the others show it at that size, with a margin or cut off at the right,
until you use them.

Every tab is your shell. The tabs sit at the bar's right, "+" at its end
opens one, and "×" closes a tab and ends what runs in it. A tab started with
a program runs it inside your shell, and the shell takes over when it exits:
leaving `claude` leaves a prompt in the same tab, not a dead one. A tab whose
shell exited offers to start it again, as it was.

```sh
whiteboard terminal [page]             # the link that opens the drawer in this browser
whiteboard terminal --new              # a new tab with the shell
whiteboard terminal -- <program> …     # run a program in a new tab: -- claude --resume <id>
whiteboard terminal open <page>        # show a page where the drawer you used last is
whiteboard terminal stop               # end every tab and their host
```

An agent can show you a page: `whiteboard terminal open <page>` takes the
browser tab whose drawer you used last to that page, and the drawer comes
along. A program in a tab knows which tab it runs in (`WHITEBOARD_TERMINAL`)
and opens it where that tab's drawer is; without it, where you were last.

The terminal runs code, so it needs the project's token: `.whiteboard/token`,
made on first use and gitignored. The link (`/_/auth`) sets it as a cookie
that is only sent from the project's own pages, and requests from another
origin are refused. Any plugin can ask the core whether a request has it.

It needs `node-pty`, an optional dependency; without it the drawer says what
to install. The host listens on `.whiteboard/terminal/host.sock`, readable
by its owner only, and leaves ten minutes after the last tab's program ended.

The token keeps other websites out, not agents: it is in the project, and so
is the config the server runs. **whiteboard runs with the rights of whoever
started its server, and adds none**, so start the server where your agents
run. If they run in a sandbox, start it from inside that sandbox (an agent
running `whiteboard show` does); the terminal and everything else it starts
are then boxed in the same way. A server started outside the sandbox lets an
agent reach past it, through the terminal or simply by editing `config.ts`.

## Claude Code

The Claude Code plugin brings your answers to an agent session without the
agent having to wait for them, and tells it what is open on its pages:

```ts
import claudeCode from '@bigmistqke/whiteboard/claude-code'

export default defineConfig({
  plugins: [claudeCode()],
})
```

With it, `whiteboard new` claims the page it makes for the Claude Code
session that ran it, and `whiteboard status` marks that session's pages.
It gets your answers to the agent in two ways, and `whiteboard claude-code
install` sets up both: the channel, which pushes them into the session, and
the reminders, which remind the agent of them as its turns end and with your
messages. `install channel` or `install reminders` sets up only one, and
`uninstall` (with the same choice) takes them out again, leaving other
servers, hooks and settings as they are. What they write runs the project's
own copy of whiteboard when it depends on one, so the files can be
committed for everyone who works on it.

### The channel

An MCP server, `whiteboard claude-code channel`, that Claude Code starts
with each session. It listens on the pages that session claimed (also ones
it claims later), as a `watch` does, and pushes each answer you give there
into the session, as a message:

```text
<channel source="whiteboard" page="plan" id="mwv…" type="scope">form scope: "Smaller"</channel>
```

The agent needs no `wait`, and gets your answer while it works. It calls
the channel's `received` tool as it starts on it: only then does the answer
count as received, and the form folds. Until then the page shows it as not
received, since Claude Code doesn't tell the server whether a message
arrived.

Channels are a research preview of Claude Code: a session loads one only
when started with

```sh
claude --dangerously-load-development-channels server:whiteboard
```

(an alias saves typing it). It works with Claude Code only: the push is
Claude Code's own extension of MCP. With many projects under one shared
server, registering it once for your user covers them all:
`claude mcp add --scope user whiteboard -- whiteboard claude-code channel`.
Problems (a page another wait holds, say) are written to
`.whiteboard/claude-code/channel.log`.

It is two parts: the server in the project's `.mcp.json`, and a silent
SessionStart hook in its `.claude/settings.json` that tells it which
session it serves (on a resume, Claude Code starts it with an id the
conversation then leaves).

### The reminders

Hooks in the project's `.claude/settings.json`:


- when a turn ends with something on the session's pages nobody listens for,
  the turn goes on once, telling the agent to start its wait (agents forget);
  a turn the hook already continued ends, and you see what is open;
- when you send a message, answers on the session's pages that no agent
  received come with it, and count as received from then on; answers it was given
  and hasn't handled, and chats waiting for its reply, are named;
- a new session starts with the same, plus what is open on other sessions'
  pages (not handed over: those answers stay for whoever waits on them).

With the channel, the reminders are the safety net: for a session started
without the flag, or an answer the agent received and then forgot.

## Commands

Every command works on the project of the current folder: the nearest folder
upward with a `.whiteboard/` folder.
`whiteboard <command> --help` (or `whiteboard help <command>`) says what a
command takes and does, its options included, and runs nothing; a plugin's
commands answer it too.

| command | does |
| --- | --- |
| `whiteboard init [name]` | make this folder a project |
| `whiteboard root` | print the folder pages go into |
| `whiteboard new <name>` | create a page under a name no other page has (`name`, else `name-2`, …), print its path |
| `whiteboard show <page\|file>` | start the project's server if needed (never the shared one), print the page's URL |
| `whiteboard url <page\|file>` | print the page's URL, when the server runs |
| `whiteboard archive <page>` | a page that did its job: it leaves the pages and its events the log, kept in `.whiteboard/archive/` as markdown with what was answered on it |
| `whiteboard destroy <page>` | a throwaway page: remove its file, and all its events from the log |
| `whiteboard prune <page> [--type <t>] [--id <id>]` | remove a page's events from the log (all, one type, or one), keep the page |
| `whiteboard edit <event id> --data <json>` | change an agent's own event in place: merged into its data, its id kept |
| `whiteboard scroll <page\|file> <where>` | scroll the tabs that have the page open to a heading's text, a form's name or any text on it; exits 1 when nothing matches or no tab has it open |
| `whiteboard docs [name]` | print how to write pages in this project: the blocks, then each plugin's docs; with a name, only that plugin's |
| `whiteboard events [filters] [--follow]` | print recorded events; with `--follow`, then each new one as it comes, marking nothing |
| `whiteboard wait [filters] [--force]` | print every matching answer the agent hasn't handled (one handed out before with `"again": true`), or wait for the next; one wait a page (`--force` takes it over); without `--page`, only what no other wait or watch would take (the fallback: one per project, or, in a project of the machine config's entries, one for the whole entry, each event with its `project` and `url`) |
| `whiteboard watch [filters] [--force]` | like `wait`, but never exits: print each answer as it comes |
| `whiteboard append --page <p> --type <t> [--data <json>]` | add an event to a page's log, such as a reply to a comment |
| `whiteboard handled <event id…>` | the agent handled these answers (a reply in their chat does it too): no wait hands them out again |
| `whiteboard status [--page <p>]` | per page: questions without an answer, answers no agent received, answers received and not handled, chats waiting for a reply, who is listening |
| `whiteboard build [globs…] [--out <dir>] [--skip <a,b>]` | pages as a static site (see [Building a site](#building-a-site)) |
| `whiteboard serve` | run the server in the foreground; for a project of the machine config's entries, or outside any project, the shared server |
| `whiteboard skill [dir]` | print where the agent skill is, or link it into a skills folder |
| `whiteboard paths [--write\|--read]` | the folders the shared server needs, `:` between them, for a sandbox wrapper to grant (see [Many projects, one server](#many-projects-one-server)) |

Filters: `--page <page|file>` (includes pages below it), `--type <type>` (a form's type is its name).
`wait` also takes `--timeout <seconds>` (exits 2 on timeout);
`events` takes `--since <time or event id>` and `--last <n>`.

## Configuration

A project needs no config. Without one it has the defaults: the built-in
plugins and the folder's name. Add `.whiteboard/config.ts` to change any of
that; it takes effect at once, also while the server runs. Every field is
optional:

```ts
// .whiteboard/config.ts
import { defineConfig } from '@bigmistqke/whiteboard'
import terminal from '@bigmistqke/whiteboard/terminal'
import code from '@bigmistqke/whiteboard/code'

export default defineConfig({
  name: 'my-project',            // shown in titles (default: the folder name)
  plugins: [                     // added to the built-in ones
    terminal(),
    code({ themes: { light: 'github-light', dark: 'github-dark' } }),   // same name: replaces the built-in
  ],
  style: new URL('./site.css', import.meta.url),   // a stylesheet on every page, after the others
  files: true,                   // serve and watch the rest of the project at /-/ (default: true)
  build: { pages: ['docs/**/*.md'] },   // what `whiteboard build` makes (see Building a site)
})
```

The page's look is CSS custom properties, set in the base stylesheet and
used by every built-in plugin, which a project's stylesheet overrides:

- colours: `--bg`, `--text`, `--muted`, `--border`, `--accent`,
  `--accent-text`, `--ok`, `--warn`, `--bad`;
- type: `--serif`, `--sans`, `--mono`; `--text-size`, one size for the
  article and the interface beside it (buttons, inputs, tables; `--ui-small`
  and `--ui-text` follow it), with headings as multiples of it, never
  smaller; the article's `--line-height` (its margins are in `em`, so they
  follow); small labels' `--ui-tiny`, and `--ui-line-height`;
- space: the article's `--rhythm` (1.2 × `--text-size`) and the steps made
  of it, from far to close: `--gap-section` (above a section's heading),
  `--gap-subsection` (above a subsection's), `--gap-heading` (under a
  heading), `--gap-block` (a set-off block: a callout, a form, a grid),
  `--gap-prose` (around a list, code, a table among paragraphs),
  `--gap-paragraph` (paragraph to paragraph),
  `--gap-group` (things side by side) and `--gap-attach` (a part attached to
  what is above it); inside a form, list item, card, details, callout or
  timeline step, the block and prose steps are the attach step; the interface's `--space-2xs` … `--space-3xl` (2, 4,
  6, 8, 10, 12, 16, 24px);
- shape: `--radius-sm`, `--radius`, `--radius-lg`, `--radius-pill`,
  `--hairline`, `--shadow-pop`; tints `--tint-faint`, `--tint-soft`,
  `--tint-strong`; `--speed`;
- widths: `--measure`, `--wide`; layers: `--layer-aside`,
  `--layer-popover`, `--layer-window`, `--layer-top` (for a plugin's own
  floating things).

Every colour is a `light-dark()` pair, so one line sets it for both themes:

```css
/* .whiteboard/site.css */
:root { --accent: light-dark(#c2410c, #fb923c); --serif: "Source Serif 4", Georgia, serif; }
/* denser: smaller text, tighter blocks */
:root { --text-size: 14px; --rhythm: 1em; }
```

The built-in plugins are ansi, badge, callout, chat, code, comments, details, draft,
forge, form, grid, iframe, lightbox, mermaid, quiet, steps, timeline, toc and window: every
project has them, and `whiteboard docs` shows how to write each. A config's `plugins` add to
them, and one with a built-in's name replaces it. The table of contents (`toc`) shows on a page
that asks for it in its frontmatter (`plugins: { toc: true }`), or on every page with
`toc({ always: true })` in the config. The terminal and the Claude Code plugin are opt-in, since
they run code or are about one agent.

Named forms need nothing in the config: the core sends a submit of any
`<form name>` as an event, on any page.

Set `files: false` for a project whose folder is not a repository, such as
your home folder. Then only `.whiteboard/` is served and watched.
`whiteboard init` sets it when run in the home folder.

## Building a site

Docs can be written as pages: the agent drafts, you comment on passages, a
form settles a choice, a chat clears up a question. Kept in a folder of the
repository (`docs/`), they are live pages at `/-/docs/…` while you write
them. `whiteboard build` turns them into a site: plain HTML files with their
images and styles, links between them relative, for GitHub Pages or any
file host.

```ts
export default defineConfig({
  build: {
    pages: ['docs/**/*.md', '!docs/notes/**'],    // which pages, as globs; ! leaves out
    skip: ['form', 'chat', 'comments', 'draft'],   // plugins or blocks left out (this is the default)
    out: 'site',                                   // where it goes (default: site)
  },
})
```

```sh
whiteboard build                                   # as configured
whiteboard build 'docs/guide/*.md' --out preview   # or what is given, over the config
```

- **What is for writing is left out:** the live channel and the event log
  (so no answers, chats or comments), new-content marks and toasts, and the
  plugins and blocks in `skip`: their blocks render as nothing, their
  stylesheets, browser modules and what they add to the page aren't included.
  A plugin's `slots` is asked with no request, since no browser asked for the
  page: the terminal's drawer, which is only for the project's own browser,
  isn't there. Files a page names (its images, an iframe's page) are copied
  beside it.
- **What is for reading stays:** steps, the lightbox, ⤢ on
  windows, the theme toggle, the contents, details. Code and diagrams were
  rendered on the server, so the site loads no highlighter.
- **`:::draft`** is for what is there while you write and not after: a note
  to check something, two versions of a paragraph. It shows marked as a
  draft, and the build leaves it out.
- **Where pages land:** at their places below the folder they share, a
  README.md or index.md as its folder's index.html (`docs/api/forms.md` →
  `site/api/forms.html`). A link to a page outside the build, or to a file
  outside that folder, stays as written, and the build says so.
- **The folder is the build's:** it is replaced on each build, and one that
  holds files a build didn't write is refused.

Open the site through a web server (`npx serve site`) rather than as files:
browsers don't run JavaScript modules from `file://`. The pages read either
way, but steps, the lightbox and the theme toggle need the server.

## Writing a plugin

Everything that extends whiteboard is a plugin: syntax for pages (blocks),
behaviour on every page, commands, routes, events, and what goes in the
page's slots (its header bar, a panel beside the text, a drawer, the corner).
A plugin is an object with a name, and everything it adds lives under that
name. Local plugins go in `.whiteboard/plugins/`.

How to write one, with examples, is in [plugins/README.md](plugins/README.md);
the plugins in that folder are the built-in ones.

## Pages

Each page is a conversation between you and the agent that writes it:
forms you answer, a chat under each form, comments on any passage, and a
page that shows at a glance what waits on whom.

````markdown
# Release plan

:::callout[Status: one question open]{.note}
The parser is done; the docs wait on the question below.
:::

:::grid{cols=2}
### Parser :badge[done]
Rewritten, all tests pass.

### Docs :badge[todo]
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

- **Forms.** The writer's recommended option is tagged, never preselected,
  so a choice is only made by picking it. What you type is kept until you
  send it, across live updates and reloads. Sending confirms itself.
- **A chat under every form,** to ask about a question without answering
  it: a message is never a submit. `:::chat{name=…}` puts one anywhere.
- **What waits for you.** Your to-do, not whether an agent's process runs:
  a question you haven't answered (or one the agent asks again), and a
  message from the agent you haven't read (a reply to your comment, a chat
  message). A message is read once it has been in view, and that is
  recorded in the log, so it holds in every browser. An answered form waits
  for an agent to receive it; once one has it, the form folds into a card:
  what you chose (several answers each on a line, under the button you
  pressed), what you wrote, and "received · change" while the agent is on
  it, "decided · change" once it handled it; a click opens it again. Its chat folds into "💬 n messages", and opens when the agent
  writes there, or stays open while you are writing in it. The corner's
  toasts go to the next question ("→ unanswered (n)") and the next
  unread message ("→ unread (n)", whose ✕ puts it away until another
  comes), and the tab title gets a `(!n)` prefix. An answer sent while no agent
  listens says so in a toast; it stays in the log for the next agent that
  checks.
- **Whether an agent listens.** The dot at the end of the header is green
  while the page is live and an agent takes its answers, grey when nobody
  listens (answers wait in the log), and a ring while the page reconnects.
- **What waits on other pages.** The header shows an inbox with how much
  waits for you on other pages; it opens a list of those pages, and a page
  in it opens at the first thing. The overview marks the same pages with
  the inbox.
- **Messages are markdown.** Comments, replies and chat messages, yours
  and the agent's: code, lists, links, `#12`, rendered like a page, but raw
  HTML and blocks show as written.
- **Comments.** Select any passage and comment on it; the agent replies in
  the thread or edits the page. Passages are found again after edits. A
  thread with a reply you haven't read has a dot on its badge.
- **What changed.** A block you haven't seen gets a bar until it has been
  in view a moment, remembered per page, so coming back shows what changed
  since. `:::quiet` content never counts as new.
- **Reading.** Updates keep your place: focus, typed values, open
  `<details>` and scroll. A frame with breadcrumbs, the time of the last
  update and a theme toggle. Numbered headings. An overview of the
  project's pages and markdown documents, and repository files rendered at
  `/-/`.

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

## Working on whiteboard

Whiteboard is TypeScript. An installed package runs its build from
`dist/`, because Node won't run TypeScript inside `node_modules`. A clone
can run from source instead, so a change needs no build:

```sh
git clone https://github.com/bigmistqke/whiteboard && cd whiteboard
npm install
ln -sf "$PWD/bin/whiteboard.ts" "$(npm prefix -g)/bin/whiteboard"   # your global `whiteboard` runs the source
npm run dev            # rebuilds the browser code as you change it
```

`whiteboard` then runs from source in every project on your machine. That
includes the server it starts, and what a project's config imports from
the package (the plugins), so a project needs nothing of its
own for this. What a change takes:

| what you change | what it takes |
| --- | --- |
| a plugin's server side (its blocks, commands, routes) | nothing: the server reloads open pages |
| browser code (a plugin's `client.ts`/`client.tsx`, `src/client/`) | `npm run dev` running; open pages reload |
| the core (`src/`, `bin/`, the markdown engine in `src/pages/`) | restart the project's server; commands pick it up on their next run |

Don't use `npm link` for this: it links `whiteboard` to the build, which
changes only when you run `npm run build`. Without a global command,
`node bin/whiteboard.ts <command>` works from inside the clone.

- `npm test`: the unit tests (`node:test`)
- `npm run test:browser`: forms, comments and the terminal in a real browser
  (Playwright; `npx playwright install chromium` once). Each test runs a
  throwaway project with its own server, from source
- `npm run check`: type-check everything
- `npm run build`: build `dist/`, what the package ships; `node
  dist/bin/whiteboard.js` runs it as an installed copy would
- `npm run release`: type-check and test, then ask for the new version
  ([bumpp](https://github.com/antfu-collective/bumpp)), commit and tag it as
  `Release vX.Y.Z`, push, and publish to npm. Publishing reads the token from
  `NPM_TOKEN` (`.npmrc`); it needs a granular token that may publish without
  a one-time password

## Design

[DESIGN.md](https://github.com/bigmistqke/whiteboard/blob/main/DESIGN.md)
records how whiteboard works and why: the principles, the engine, the
plugin contract and the page in the browser.

## License

MIT
