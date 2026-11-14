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
   written in this project (with the basic renderer: the current syntax of
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
  with a distinct name. When the options need explaining, explain them in
  the form, each option with its meaning (`- label | what it means`, see the
  form template's docs), not in a section above it: the user decides where
  they read. Keep `:::details` for real depth, not for the options.
- Don't number headings yourself (`### 1. Naming`): the basic renderer
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

## Showing the page beside the conversation

When you run inside herdr (`HERDR_ENV=1`, and `HERDR_PANE_ID` names your pane)
and `terminal-browser` is on the PATH, open the page in a browser next to
yours instead of only printing the URL. The user then reads the page and talks
to you side by side. Do this the first time you show a page in a session, or
when the user asks to see one.

**One browser, a tab per page.** The first page opens a browser in a pane to
the right of yours; every later page opens as a new tab in that same browser,
not in another pane or herdr tab:

```sh
terminal-browser new-tab <url>
```

With no browser in your herdr tab yet, this opens one in a split to the right;
with one, it adds a tab to it. When there are several, it asks for one:
`terminal-browser ls` lists them with their key, and
`terminal-browser new-tab --browser <key> <url>` picks it. Later edits to a
page show up in its tab by themselves, so open each page once.

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
- `whiteboard watch --page <file>` is `wait` that never exits: it prints
  every answer on the page once, also those given while no watch ran (for a
  monitor that stays open, and one you restart). Use this for a page with
  several forms: the user
  answers them one at a time, and each answer deserves a reply. Do not use
  `wait --count <n>` for that: it returns only after all n answers, so the
  first ones go unread until the last arrives.
- `whiteboard events --page <file> [--type <name>] [--last 1]` lists what was
  submitted so far, for when you need the history rather than the next
  answer.

While `wait` or `watch` runs, the page shows the user what you are waiting
for: the forms it covers are marked "waiting for you", a button jumps from
one to the next, and the tab title counts them. Forms nobody waits for say
that no agent is listening. So:

- Keep a `wait` or `watch` running for as long as you want answers, and only
  then. Don't poll `whiteboard events` in a loop instead: the user can't see
  that you are waiting.
- When you need the user to read something before you go on, put a form with
  just a button under it (`submit: Read it`) and wait for it. Then
  everything you wait for is a form the page can point to.

After acting on an answer, update the page to say what you did with it.
