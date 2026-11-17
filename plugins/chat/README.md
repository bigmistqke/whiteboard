A chat between the reader and you: the reader types (Enter sends,
Shift+Enter starts a new line), you answer, the reader's messages on one side
and yours on the other. Every form has one under it, for questions about the
question; a `chat` block puts one anywhere, for talk that isn't about a form.

```markdown
:::chat{name=notes}
Anything about the plan that isn't a decision: write it here.
:::
```

:::chat{name=notes}
Anything about the plan that isn't a decision: write it here.
:::

What the block says above the chat is ordinary markdown, and optional:
`::chat{name=page}` alone is a bare chat. Give each chat on a page its own
name, other than the page's forms' names: a form's chat has the form's name.

A message is a `chat:message` event, `{ "chat": "<name>", "text": "…" }`,
never an answer: under a form it never makes a choice. Answer in the same chat:

```sh
whiteboard append --page <file> --type chat:message --data '{"chat":"<name>","text":"your answer"}'
```

Two more fields, both optional:

- `replaces`: the id of an earlier message of yours. Yours takes its place,
  to correct it; the log itself only grows.
- `replyTo` (in a form's chat): the id of a submit of the form whose written
  text you answer (a remark typed into one of its text fields). That text
  shows as the reader's message, right before yours.

Your messages show as the agent's, and `wait` and `watch` skip what you
append. A wait on the whole page (no `--type`) hands out chat messages too;
a wait with `--type <form name>` does not. So don't add a free-text field
for questions or remarks to a decision form: its chat is for that, and a
submit stays a choice.

A chat is found by its name. Remove or rename a form or a chat block and its
chat moves to the end of the page, read-only, under "Chats no longer on this
page" (you can still answer there); bring it back under its name and the chat
is in its place again. So rework a question in its form rather than
replacing the form.
