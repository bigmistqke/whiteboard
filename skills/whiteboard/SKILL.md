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
  with a distinct name.
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
and `terminal-browser` is on the PATH, open the page in a pane next to yours
instead of only printing the URL. The user then reads the page and talks to you
side by side. Do this the first time you show a page in a session, or when the
user asks to see one.

```sh
herdr pane split --current --direction right --cwd "$PWD"   # prints JSON; the new id is result.pane.pane_id
herdr pane run <new-pane-id> terminal-browser <url>
```

- Open the pane once and remember its id. Later edits to the page show up in
  it by themselves; for a different page, close that pane
  (`herdr pane close <id>`) and open a new one the same way.
- `terminal-browser` may be blocked inside your own sandbox but runs fine in
  the herdr pane, which herdr starts outside it.
- `herdr pane read` returns no text for terminal-browser, since it draws with
  graphics. To check it started, look for it in
  `herdr pane process-info --pane <id>`.

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
- `whiteboard watch --page <file>` streams every submit on a page (for a
  monitor that stays open). Use this for a page with several forms: the user
  answers them one at a time, and each answer deserves a reply. Do not use
  `wait --count <n>` for that: it returns only after all n answers, so the
  first ones go unread until the last arrives.
- `whiteboard events --page <file> [--type <name>] [--last 1]` lists what was
  submitted so far, for when you need the history rather than the next
  answer.

After acting on an answer, update the page to say what you did with it.
