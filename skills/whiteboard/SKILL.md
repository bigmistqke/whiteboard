---
name: whiteboard
description: Show the user a live HTML page written in markdown, and get answers back through forms on it. Use when an explanation, plan, comparison, status overview or set of open questions would read better as a page than as terminal text; when the user has to re-ask about something explained earlier (put it on a page they can keep open); when work is long-running and the user needs an overview of what is pending, running and done; or when you need decisions from the user that you can wait on while they read.
---

# whiteboard

Pages are markdown files. In a repository set up for whiteboard they live in
`.whiteboard/pages/` and are served by the project's own server, at a port
`whiteboard show` prints. The user keeps them open in a browser; every save
of the file updates the open page in place, and the blocks that changed are
marked until the user has seen them. Forms on a page write the user's answers
to an ndjson log you can wait on.

The commands below are written as `whiteboard …`. When that is not on the
PATH, the project has it installed locally: run them as `npx whiteboard …`.

## Writing a page

1. Run `whiteboard docs` once per session and read it: it is how pages are
   written in this project (with the markboard renderer: the current syntax of
   every template it can use). Do not rely on memory for
   template syntax; the set differs per project. If it says there is no
   project, ask the user before running `whiteboard init`: it adds a folder
   to their repository.
2. Run `whiteboard new <topic>` (subfolders are fine: `task/plan`). It
   creates an empty page with a name no other page has, `<topic>` or else
   `<topic>-2` and so on, and prints its path. That file is yours: other
   agents may be writing pages in the same project, so never write a page you
   did not get from `whiteboard new`, and never pick a page name yourself.
3. Write the page into that file.
4. Run `whiteboard show <file>`: it starts the server if needed and prints the
   URL. Give the user the URL the first time; after that, just keep editing
   the file — the open page follows.

Files that already exist in the repository render too: `whiteboard show
README.md` (any path in the project) gives a URL that renders that file, and
relative links in it lead to the other files they name (unless the config
sets `files: false`, as a project in the home folder does). Link to existing
documents and code from your pages with relative paths instead of copying
them.

Write for a reader who comes back later:

- Lead with the state of things; put depth in `:::details[…]` blocks so the
  page stays scannable.
- Update your page rather than starting a new one for the same topic; changed
  blocks are highlighted for the user, unchanged ones stay quiet.
- Put the things you need from the user in forms, one form per decision, each
  with a distinct name. A form is markdown with its inputs inline (see the
  form template's docs). When the options need explaining, explain them in
  the form, each option with its meaning right under it, not in a section
  above it: the user decides where they read. Keep `:::details` for real
  depth, not for the options.
- A send is a choice, and only that. Questions and remarks about a form go
  in its thread (`thread` events, see the form template's docs): answer them
  there, and never read a thread message, or a note sent along with a
  submit, as a choice. Don't add a notes field to a decision form for
  questions; the thread is for that.
- Don't number headings yourself (`### 1. Naming`): the markboard renderer
  numbers section headings already, so yours would show twice. Refer to a
  section by its name.
- When you only repeat back what the user answered, or update a status line
  or timestamp, put it in `:::quiet` (if the project's docs list it): changed
  blocks are marked for the user, and an echo of their own answer is not
  news. Anything they need to read (a question back, a different reading of
  their answer, a new explanation) stays outside it.

Anything that is not a template (plain markdown, GFM tables, `<details>`, a raw
`<form name="…">`) works without one. An unknown `:::name` block still renders
its content, so a typo never breaks the page.

**Nesting containers:** the outer fence needs more colons than anything
inside it, `::::grid` around `:::details`. A `:::` closes the first open
container whose fence is no longer than its own, so with equal colons the
inner close ends the outer block too. This also counts lines of colons inside
a code block within a container: a code example containing `::::` needs a
container of at least five.

## Showing the page beside the conversation

Open the page in a browser next to your pane instead of only printing the URL.
The user then reads the page and talks to you side by side. Do this the first
time you show a page in a session, or when the user asks to see one. Which
browser depends on where you run: in cmux, its own browser pane; in herdr,
terminal-browser.

**One browser pane, a tab per page.** The first page opens a browser pane to
the right of yours; every later page opens as a new tab in that same pane, not
in another pane or workspace. Later edits to a page show up in its tab by
themselves, so open each page once.

### In cmux

When `CMUX_WORKSPACE_ID` is set, you run in cmux, and its browser pane is a
native web view beside your terminal. The `cmux` command works from a sandbox,
so run it directly.

Find out whether your workspace has a browser pane already:

```sh
cmux tree        # this workspace's panes, their surfaces (tabs) with [browser], title and URL
```

- **No browser pane yet:** `cmux browser open <url>` opens one in a split to
  the right, without taking focus. It prints `surface=surface:N pane=pane:M`.
- **A browser pane already:** add the page as a tab in it, without taking
  focus from the user's terminal:

  ```sh
  cmux new-surface --type browser --pane pane:M --url <url> --focus false
  ```

  Not `cmux browser … tab new`: that moves keyboard focus into the browser,
  away from the conversation.

- Each tab's title in `cmux tree` is the page's title: one starting with `(!n)`
  has n forms waiting for the user.
- `cmux browser --surface surface:N eval '…'` (or `snapshot`, `get text`,
  `click <css>`, `screenshot --out <file>`) works in the user's open tab, so
  you can check how a page actually renders instead of asking. `cmux help
  browser` lists the commands.

### In herdr

When you run inside herdr (`HERDR_ENV=1`, and `HERDR_PANE_ID` names your pane)
and `terminal-browser` is on the PATH, it is the browser:

```sh
terminal-browser new-tab <url>
```

With no browser in your herdr tab yet, this opens one in a split to the right;
with one, it adds a tab to it. When there are several, it asks for one:
`terminal-browser ls` lists them with their key, and
`terminal-browser new-tab --browser <key> <url>` picks it.

**From a sandbox.** `terminal-browser` may be blocked inside your sandbox
("Operation not permitted"). herdr starts panes outside it, so run the command
in a short-lived pane and read what it printed:

```sh
herdr pane split --current --direction down --cwd "$PWD"     # JSON; the new id is result.pane.pane_id
herdr pane run <id> 'terminal-browser new-tab <url> 2>&1; echo DONE_$((40+2))'
herdr pane wait-output <id> --match DONE_42                  # the marker is computed, so the echoed command doesn't match it
herdr pane read <id> --source recent-unwrapped --format text
herdr pane close <id>
```

- `terminal-browser ls` shows each browser's tabs and their titles: a title
  starting with `(!n)` has n forms waiting for the user.
- `terminal-browser action -- snapshot` (or `eval "…"`, `click @e14`) works
  in the user's open browser, so you can check how a page actually renders
  instead of asking. `terminal-browser action --help` has the selectors.
- `herdr pane read` returns no text for a pane showing the browser itself,
  since it draws with graphics.

## Getting answers

Each submit of a named form appends one line to the project's
`.whiteboard/events.ndjson`:

```json
{"id":"…","ts":"2026-…","page":"plan","type":"deploy-review","action":"Approve","data":{"notes":"…"}}
```

Pass your page's file path as `--page`, so you only hear about your own
page (`--page plan` also works, and includes the pages below `plan/`).

- `whiteboard wait --page <file> --type <name>` prints the next answer to that
  form and exits (`--timeout <s>` exits 2 on timeout). It first hands out
  answers it has not handed out before, also ones given before you started
  waiting, so you never miss one and never get one twice. Run it in the
  background and keep working; you are notified when it exits.
- **A page with several forms: one `wait` per answer.** Run
  `whiteboard wait --page <file>` (no `--type`: any answer on the page) in
  the background. It exits on the next answer, and that exit notifies you.
  Act on the answer, then run the wait again for as long as the page still
  has forms without an answer. When all are answered, stop: nothing keeps
  running. When you add a question later, start a wait again. An answer
  given between two waits is not lost: the next wait hands it out first.
  Background commands have no time limit, unlike a monitor tool, which
  expires. Do not use `wait --count <n>`: it returns only after all n
  answers, so the first ones go unread until the last arrives.
- `whiteboard watch --page <file>` is `wait` that never exits: it prints
  every answer on the page once, also those given while no watch ran. Use it
  only with something that reports each printed line as it comes (a
  monitor), and restart it when that expires.
- `whiteboard events --page <file> [--type <name>] [--last 1]` lists what was
  submitted so far, for when you need the history rather than the next
  answer.

While `wait` or `watch` runs, the page shows the user what you are waiting
for: the forms it covers are marked "waiting for you", a button jumps from
one to the next, and the tab title counts them. Forms nobody waits for say
that no agent is listening. So:

- An answer counts as picked up once your `wait` or `watch` hands it to you;
  the form then folds into one line quoting it, as decided. Answers no wait
  has handed out show as waiting for you to pick them up.
- Keep a `wait` or `watch` running for as long as you want answers, and only
  then. Don't poll `whiteboard events` in a loop instead: the user can't see
  that you are waiting.
- When you need the user to read something before you go on, put a form with
  just a button in it (`:button[Read it]`) and wait for it. Then
  everything you wait for is a form the page can point to.

### Status and hooks

`whiteboard status` lists, per page, the questions without an answer, the
answers no agent picked up, and who is listening, with the `wait` command
that picks them up. Pages are claimed by the session that ran
`whiteboard new` for them, and `status` marks yours. Run it when you resume
work, or when you're unsure what is still open.

A project can have Claude Code hooks for this (`whiteboard hooks install`;
`whiteboard init` asks). None of them ever blocks:

- when your turn ends with something on your pages nobody listens for, the
  user sees a one-line warning;
- when the user sends a message, answers on your pages that no wait picked
  up come with it, and count as picked up from then on;
- a new session starts with the same, plus what is open on other sessions'
  pages (not handed over: those answers stay for whoever waits on them).

So when a message arrives with answers from the hook, act on them as on
answers from a wait, and start a wait when it says nobody listens.

The user can also select text on a page and comment on it: a `watch` on the
page hands you those as `comment` events. `whiteboard docs` says how to reply
(by editing the page, or in the thread with `whiteboard append`).

After acting on an answer, update the page to say what you did with it.
