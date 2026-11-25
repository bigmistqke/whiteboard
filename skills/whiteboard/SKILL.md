---
name: whiteboard
description: Show the user a live HTML page written in markdown, and get answers back through forms on it. Use when an explanation, plan, comparison, status overview or set of open questions would read better as a page than as terminal text; when the user has to re-ask about something explained earlier (put it on a page they can keep open); when work is long-running and the user needs an overview of what is pending, running and done; or when you need decisions from the user that you can wait on while they read.
---

# whiteboard

Pages are markdown files. In a repository set up for whiteboard they live in
`.whiteboard/pages/` and are served by the project's server, at the address
`whiteboard show` prints: the project's own, or one server the user runs for
many projects (their worktrees and job folders), under the project's path. The user keeps them open in a browser; every save
of the file updates the open page in place, and the blocks that changed are
marked until the user has seen them. Forms on a page write the user's answers
to an ndjson log you can wait on.

The commands below are written as `whiteboard …`. When that is not on the
PATH, the project has it installed locally: run them as `npx whiteboard …`.
`whiteboard <command> --help` says what any command takes and does (the
project's plugins' commands too) and runs nothing; `whiteboard help` lists
them all.

## Writing a page

1. Run `whiteboard docs` once per session and read it: it is how pages are
   written in this project: the syntax of every block its plugins bring, and
   what their events mean. Do not rely on memory for block syntax; the set
   differs per project. If it says there is no
   project, ask the user before running `whiteboard init`: it adds a folder
   to their repository.
2. Run `whiteboard new <topic>` (subfolders are fine: `task/plan`). It
   creates an empty page with a name no other page has, `<topic>` or else
   `<topic>-2` and so on, and prints its path. That file is yours: other
   agents may be writing pages in the same project, so never write a page you
   did not get from `whiteboard new`, and never pick a page name yourself.
3. Write the page into that file.
4. Run `whiteboard show <file>`: it starts the project's server if needed and
   prints the URL. Give the user the URL the first time; after that, just
   keep editing the file — the open page follows. When the project is served
   by the user's shared server and that isn't running, `show` says so and
   starts nothing: tell the user, don't try to start it yourself (it is started outside your sandbox). Should a command say it `cannot read` whiteboard's config, your sandbox lacks a grant for it: tell the user, rather than working around it. A `wait` meanwhile still works: it waits
   for the server, and answers in the log reach it either way.
5. A page that was only for the moment (one question, a check, a demo):
   once it has done its job and you've acted on its answers, close it with
   `whiteboard close <file>`. That removes the page and its events (answers,
   chats, comments) from the log, so it doesn't linger in the overview or in
   `whiteboard status`. Keep pages the user may come back to (plans, reviews,
   decisions); close only your own, and ask when unsure.

Never edit `.whiteboard/events.ndjson` yourself: an answer arriving while you
write it is lost, and running waits stumble over it. To change what you wrote
(a chat message, a reply), use `whiteboard edit <event id> --data <json>`: it
merges into the event's data, keeps its id, and the open page shows the new
version. To clear a page's history and keep the page, `whiteboard prune
<file>` (all its events: its questions are open again), with `--type <type>`
for one kind (`chat:message`) or `--id <event id>` for one. You can edit only
your own events: what the user sent stays as they sent it.

When you take a question off a page for good (you acted on its answer and
removed the form, or removed a chat block), remove its chat too:
`whiteboard chat prune <file> <name>`. Otherwise its messages stay behind,
in a folded list of chats no longer on the page.

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
  with a distinct name (no colon: those are reserved for event types like
  `chat:message`). A form is markdown with its inputs inline (see the
  form plugin's docs). When the options need explaining, explain them in
  the form, each option with its meaning right under it, not in a section
  above it: the user decides where they read. Keep `:::details` for real
  depth, not for the options.
- A send is a choice, and only that. Questions and remarks about a form go
  in the chat under it (`chat:message` events, see the chat plugin's docs):
  answer them there, and never read a chat message, or a note sent along
  with a submit, as a choice. Don't add a notes field to a form; its chat is
  for that. When the user may want an answer you didn't list, add an option
  for it, `:radio[Other]{name=… other}`: it has a text box, and sends what
  they typed.
- For talk that isn't about a question, put a chat on the page:
  `:::chat{name=…}`, at the end or in a section. It is the same chat as
  under a form, without the question.
- When a question changes, rework it inside its form and keep the form's
  name. The chat belongs to the form by name: replace or rename the form and
  its chat moves to the end of the page, away from the question.
- Don't number headings yourself (`### 1. Naming`): the page
  numbers section headings already, so yours would show twice. Refer to a
  section by its name.
- When you only repeat back what the user answered, or update a status line
  or timestamp, put it in `:::quiet` (if the project's docs list it): changed
  blocks are marked for the user, and an echo of their own answer is not
  news. Anything they need to read (a question back, a different reading of
  their answer, a new explanation) stays outside it.

Plain markdown, GFM tables, `<details>` and a raw `<form name="…">` work
without any block. An unknown `:::name` block still renders its content, so
a typo never breaks the page.

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
browser depends on where you run: in whiteboard's own terminal drawer, the
page around it; in cmux, its own browser pane; in herdr, terminal-browser.

### In whiteboard's terminal drawer

When you run in a tab of the terminal drawer at the bottom of the user's
whiteboard pages (`WHITEBOARD_TERMINAL` is set, or the user says so), the
browser is right there:

```sh
whiteboard terminal open <file>     # the browser tab the user is in goes to that page; the drawer comes along
```

It works without `WHITEBOARD_TERMINAL` too (a sandbox may filter it out):
then it uses the drawer the user used last.

It replaces the page the user is looking at, so open a page when they asked
to see it or when you just wrote it for them, not while they read another.

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

### Pointing at a place on the page

`whiteboard scroll <file> <where>` scrolls every tab that has the page open
to a heading (by its text), a form (by its name) or any text on it, opens a
details around it, and lights it up a moment. Use it when you talk about a
part of a long page ("see the risks section"), or to bring the user to a
question you just added. It exits 1 when nothing on the page matches, or when
no tab of the page is connected now: then a tab that is open still scrolls
there once it is back (a background tab connects again when it is shown);
else `show` the page first.

## Getting answers

Each submit of a named form appends one line to the project's
`.whiteboard/events.ndjson`:

```json
{"id":"…","ts":"2026-…","page":"plan","type":"deploy-review","action":"Approve","data":{"notes":"…"}}
```

**In Claude Code with the whiteboard channel,** answers come to you by
themselves: messages `<channel source="whiteboard" page="…" id="…">`, one
per answer on the pages your session made with `whiteboard new`, even
while you work. You then need no `wait` on those pages. For each message:
call the channel's `received` tool with its id as you start on it (the
user's form folds, and they see you have it), act on it, then handle it
(reply in its chat, or `whiteboard handled <id>`). The channel is there
when the session's tools include whiteboard's `received`; the page shows
it as listening. Without it, wait as below.

Pass your page's file path as `--page`, so you only hear about your own
page (`--page plan` also works, and includes the pages below `plan/`).
With several pages, give `--page` once for each, in one wait
(`whiteboard wait --page a.md --page b.md`): it listens on all of them and
exits with the answers of any. Never watch pages by polling `whiteboard
events` in a loop: that reads the log without listening, so the pages
tell the user that no agent is listening and their answers wait.

- `whiteboard wait --page <file>` prints every answer on the page you
  haven't handled yet, one line each, and exits; with none, it blocks until
  the next one comes (`--type <name>` for one form only, `--timeout <s>`
  exits 2). Answers given before you started waiting are there too, so you
  never miss one. Run it in the background and keep working; you are
  notified when it exits.
- **Handle every answer you're given.** Once you acted on an answer, reply
  in its chat (that handles it) or run `whiteboard handled <id>`. Until then it
  counts as received, not done: the next wait hands it to you again, marked
  `"again": true`, and the page shows "received" instead of decided. A chat message is handled by replying in that chat, a comment
  by replying in its thread.
- **Run the wait again** for as long as the page has questions or chats
  waiting: when it exits it lists, on stderr, the answers still to handle
  (with `whiteboard handled`), the chats waiting for your reply, and the
  questions still unanswered. When nothing is left, stop: nothing keeps
  running. When you add a question later, start a wait again. Background
  commands have no time limit, unlike a monitor tool, which expires.
- **One wait per page.** A second wait or watch on a page that already has
  one is refused (exit 1). Check you don't have one running already (an
  earlier background task); if it is stale, `--force` takes the page over,
  and the old one exits 3, saying a newer wait took it over. A wait of
  yours that exits 3 no longer listens.
- `whiteboard watch --page <file>` is `wait` that never exits: it prints
  every answer on the page once, also those given while no watch ran. Use it
  only with something that reports each printed line as it comes (a
  monitor), and restart it when that expires.
- Without `--page`, `wait` and `watch` are the fallback: they hand out only
  what no other wait or watch would take, on any page (also answers left
  from sessions that ended). In a project of the user's shared server it
  covers every project served with it (all their worktrees and job folders),
  and each answer says where it is from: `project` (its folder) and `url`;
  act on it in that folder. One runs at a time (per project, or per shared
  group); a second exits 1. Use it only when asked to look after the whole
  board; for your own pages, always pass `--page`.
- `whiteboard events --page <file> [--type <name>] [--last 1]` lists what was
  submitted so far, for when you need the history rather than the next
  answer. With `--follow` it then prints each new event as it comes, without
  taking anything. Use these only for something `wait` doesn't do, never
  to watch for answers.

The page shows the user what waits for them: every question without an
answer is outlined as waiting for them, and so is a message from you they
haven't read (a reply in a comment thread, a chat message). Labels in the
page's corner ("→ unanswered (n)", "→ unread (n)") go from one to the next,
and the tab title and the header count them. Whether
your wait runs doesn't change that, so answers given while none runs wait in
the log for you. So:

- An answer goes through three states: not received (no agent has it
  yet: the form waits, ringed grey), received (your `wait` or `watch`
  handed it to you: the form folds into a card showing the answer, marked
  "received", with its chat folded into "💬 n messages"; your messages
  there still open it for the user), and handled (you replied in its chat
  or ran `whiteboard handled <id>`: the card says "decided"). Waiting on a
  handled form by name (`--type`) asks the user again: it is open again.
- Keep a `wait` or `watch` running for as long as you want answers, and only
  then. Don't poll `whiteboard events` in a loop instead: it marks nothing
  received, so the user's answers never show as received, and the hooks and
  `whiteboard status` keep reporting them. When an answer arrives while no
  wait runs, the user is told nobody is listening right now.
- When you need the user to read something before you go on, put a form with
  just a button in it (`:button[Read it]`) and wait for it. Then
  everything you wait for is a form the page can point to.

### Status and hooks

`whiteboard status` lists, per page, the questions waiting for the user (no
answer yet, or a wait asks for a new one), the answers no agent received, the
answers received and not handled (with `whiteboard handled`), the chats
waiting for a reply, and who is listening, with the `wait` command that
takes them. It covers every page: it is your inbox. Pages are claimed by the session that ran
`whiteboard new` for them, and `status` marks yours. Run it when you resume
work, or when you're unsure what is still open.

When `wait` hands you answers, it also says (on stderr) what is left on the
page: answers to handle, chats waiting for your reply, questions still
unanswered, with the command to wait again: run it once you've acted on the
answers.

A project can have Claude Code hooks for this: the Claude Code plugin in
its config, and `whiteboard claude-code install` (which sets up the channel
too; `install hooks` for only the hooks):

- when your turn ends with something on your pages nobody listens for, your
  turn goes on once, telling you to start the wait: start it in the
  background and end your turn;
- when the user sends a message, answers on your pages that no agent received
  come with it, and count as received from then on (handle them as any
  others); answers you were given and haven't handled, and chats waiting
  for your reply, are named;
- a new session starts with the same, plus what is open on other sessions'
  pages (not handed over: those answers stay for whoever waits on them).

So when a message arrives with answers from the hook, act on them as on
answers from a wait, and start a wait when it says nobody listens.

The user can also select text on a page and comment on it, or comment on
lines of a code block: a `wait` or `watch` on the whole page hands you those
as `comments:new` events. `whiteboard docs` says how to reply (by editing the
page, or in the thread with `whiteboard append`).

After acting on an answer, update the page to say what you did with it.

## Putting changes up for review

To have the user review code you changed, write the diff into a page, one
file at a time: each file's diff in a `diff` fence, inside a chat named
after the file. The fence shows the file's name, where each part starts
and line numbers, and leaves out the headers only tools read. Its lines are coloured, the user can comment on any of them
(each comment's `at` says which file and line: `src/a.ts:12`, or
`src/a.ts (old):9` for a removed line), and the chat under it is for the
file as a whole. End with a form for the verdict.

```sh
git add -N .   # new files show in the diff too
{ printf '# Review: <what changed>\n\n<why, in a few lines>\n\n'
  git diff HEAD --name-only | while read -r f; do
    printf ':::chat{name="%s"}\n````diff\n' "$f"
    git diff HEAD -- "$f"
    printf '````\n:::\n\n'
  done
  printf ':::form{name=review}\n:button[Approve] :button[Request changes]\n:::\n'
} > .whiteboard/pages/review.md
```

Then `whiteboard wait --page review`: it hands you the line comments
(`comments:new`), the messages about a file (`chat:message`, with the file
as `chat`) and the verdict. For a comment or message, change the code or
reply in its thread; after changing code, write the page again the same
way, so each diff shows what the file is now (comments whose lines are gone
stay open, marked as no longer on the page, beside where they were, or
listed after the page when nothing of there is left; a file's chat stays
with its name). Add a line of explanation above a file's
fence where it helps. Use four backticks for the fence, since a diff can
hold three.
