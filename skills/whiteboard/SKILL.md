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

1. Run `whiteboard root` in the repository. It prints the folder to write pages
   into: the project's `.whiteboard/pages/` (the nearest `.whiteboard/config.ts`
   upward). If it says there is no project, ask the user before running
   `whiteboard init`: it adds a folder to their repository.
2. Run `whiteboard docs` once per session and read it: it is the current
   syntax of every template this project can use. Do not rely on memory for
   template syntax; the set differs per project.
3. Write `<root>/<topic>.md` (subfolders are fine).
4. Run `whiteboard show <topic>`: it starts the server if needed and prints the
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
- Update a page rather than starting a new one for the same topic; changed
  blocks are highlighted for the user, unchanged ones stay quiet.
- Put the things you need from the user in forms, one form per decision, each
  with a distinct name.

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
{"id":"…","ts":"2026-…","page":"plan","form":"deploy-review","action":"Approve","data":{"notes":"…"}}
```

`--page plan` means the project's page `plan`; a file path
works too.

- `whiteboard wait --page <file> --form <name>` blocks until the next submit of
  that form and prints it (`--timeout <s>` exits 2 on timeout). Run it in the
  background and keep working; you are notified when it exits.
- `whiteboard watch --page <file>` streams every submit on a page (for a
  monitor that stays open).
- `whiteboard events --page <file> [--form <name>] [--last 1]` reads what was
  already submitted — check this before asking again; the user may have
  answered while you were busy.

After acting on an answer, update the page to say what you did with it.
