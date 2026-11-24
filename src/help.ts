// The help of the built-in commands: what each takes and does, for `whiteboard <command> --help`
// (which prints it and exits before the command does anything), and the overview `whiteboard help`
// lists from the same entries, so the two never drift. A plugin's commands have theirs from what
// they declare (src/plugins.ts, commandHelp).

export interface CommandHelp {
  /** what follows the command's name: `<page|file> [--type <type>]` */
  usage: string
  /** one line, for the overview */
  summary: string
  /** its options and what to know beyond the summary, for its own help */
  details?: string
}

const FILTERS = `  --page <page|file>   only that page and the pages below it
  --type <type>        only events of that type (a form's name, chat:message, comments:new…)`

export const COMMAND_HELP: Record<string, CommandHelp> = {
  init: {
    usage: '[name]',
    summary: 'make this folder a project: .whiteboard/pages/',
    details: 'Writes a config only for what differs from the defaults (a name; files: false in the home folder).',
  },
  root: { usage: '', summary: "print where pages go (this project's .whiteboard/pages)" },
  new: {
    usage: '<name>',
    summary: 'create a page under a name no other page has (name, name-2, …), print its path',
    details: 'Subfolders are fine (task/plan). The page is claimed by the session that ran it.',
  },
  show: {
    usage: '<page|file>',
    summary: "start this project's server if needed, print the page's URL",
    details: "Any file of the project renders too (README.md). Under a shared server that isn't running, says so and starts nothing.",
  },
  url: { usage: '<page|file>', summary: "print the page's URL (as show)" },
  close: {
    usage: '<page|file>',
    summary: 'a page that did its job: remove its file, and its events from the log',
  },
  prune: {
    usage: '<page|file> [--type <type>] [--id <event id>]',
    summary: "remove a page's events from the log, keep the page",
    details: `  --type <type>        only the events of that type
  --id <event id>      only that event

Without either, all of the page's events: its questions are open again.
One chat's messages: whiteboard chat prune <page|file> <chat>.`,
  },
  build: {
    usage: '[globs…] [--out <dir>] [--skip <a,b>]',
    summary: 'pages as a static site: plain HTML, links relative',
    details: `  --out <dir>          where to write it (default: the config's build.out)
  --skip <a,b>         plugins or blocks to leave out (default: form, chat, comments, draft)`,
  },
  edit: {
    usage: '<event id> --data <json>',
    summary: "change an agent's own event in place (merged into its data)",
    details: "Keeps its id, so what refers to it still does. What the reader sent can't be edited.",
  },
  scroll: {
    usage: '<page|file> <where>',
    summary: "scroll the tabs that have the page open to a heading's text, a form's name or any text",
    details: 'Opens details around it and lights it up. Exits 1 when nothing matches or no tab of the page is connected.',
  },
  docs: {
    usage: '[plugin]',
    summary: "how to write pages here: markdown, and each plugin's blocks; read it before writing one",
    details: "With a plugin's name, only its docs.",
  },
  events: {
    usage: '[--page <p>] [--type <t>] [--since <time|id>] [--last <n>] [--follow]',
    summary: 'print recorded events as ndjson; marks nothing received',
    details: `${FILTERS}
  --since <time|id>    only those after an ISO time or an event id
  --last <n>           only the last n
  --follow             then print each new one as it comes`,
  },
  wait: {
    usage: '[--page <p>] [--type <t>] [--timeout <s>] [--force]',
    summary: "print every answer you haven't handled, or block for the next; each counts as received",
    details: `${FILTERS}
  --timeout <seconds>  exit 2 when nothing came
  --force              take the page over from another wait or watch on it (that one exits 3)

It prints, one line each, every answer on the page you haven't handled, also from before it started,
and exits; with none, it blocks until the next comes. An answer printed before and still not
handled comes again, with "again": true. You handle one by replying in its chat (or to it), or with
whiteboard handled <id>. Then it lists what is left: answers to handle, chats waiting for your reply,
questions still unanswered.

One wait or watch a page: a second is refused (exit 1) unless --force. Without --page it is the
fallback: only what no other wait or watch would take, on any page; one runs per project (a second
exits 1), or, in a project of the machine's entries, one for the whole entry.`,
  },
  watch: {
    usage: '[--page <p>] [--type <t>] [--force]',
    summary: 'like wait, but never exits: print each answer as it comes',
    details: `${FILTERS}
  --force              take the page over from another wait or watch on it

Without --page it is the fallback, as for wait.`,
  },
  append: {
    usage: '--page <p> --type <t> [--data <json>]',
    summary: "add an event to a page's log, as the agent (a reply, a chat message)",
  },
  handled: {
    usage: '<event id> [<event id>…]',
    summary: 'you are done with these answers: handled, so no wait hands them out again and nothing reminds you of them',
    details: 'Replying in an answer\'s chat (or to it) handles it too.',
  },
  status: {
    usage: '[--page <p>]',
    summary: 'per page: questions without an answer, answers not received or not handled, chats waiting for a reply, who listens',
  },
  serve: {
    usage: '',
    summary: "run this project's server in the foreground; outside a project or for one of the machine's entries, the shared server",
  },
  skill: { usage: '[dir]', summary: 'print where the agent skill is, or link it into a skills folder' },
  paths: {
    usage: '[--write|--read]',
    summary: 'the folders the shared server needs, for a sandbox wrapper to grant',
    details: `  --write              the entries' folders and the server's state
  --read               the machine config and whiteboard itself`,
  },
  help: { usage: '[command]', summary: 'this overview; with a command, its help (as <command> --help)' },
}

/** `whiteboard <name> --help`: its usage, what it does, and its options. */
export function commandHelp(name: string): string {
  const h = COMMAND_HELP[name]
  if (!h) throw new Error(`no command ${name}`)
  return [`usage: whiteboard ${[name, h.usage].filter(Boolean).join(' ')}`, '', h.summary, h.details ? `\n${h.details}` : '']
    .join('\n')
    .trimEnd()
}

/** The overview's list of commands, one line each. */
export function commandList(): string {
  const lines = Object.entries(COMMAND_HELP).map(([name, h]) => {
    const head = `  whiteboard ${[name, h.usage].filter(Boolean).join(' ')}`
    return head.length < 36 ? `${head.padEnd(36)} ${h.summary}` : `${head}\n${' '.repeat(37)}${h.summary}`
  })
  return lines.join('\n')
}
