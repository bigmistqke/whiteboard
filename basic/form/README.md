# form

Shorthand for a named form. Submitting it appends
`{ id, ts, page, type, action, data }` to the events log, where `type` is the
name after `form` on the fence line, `action` is the button that was pressed
and `data` holds the fields. The form shows the last submission and starts
from its values.

One line per field, `type: name | label | extra`:

| line | renders |
| --- | --- |
| `text: name \| Label \| placeholder` | a text input (also `number`, `date`, `range`) |
| `textarea: name \| Label \| placeholder` | a multi-line input |
| `select: name \| Label \| a, *b, c` | a dropdown; `*` marks the default |
| `radio: name \| Label \| a, b` | one choice; `data.name` is the value or `null` |
| `checkbox: name \| Label \| a, b` | several choices; `data.name` is an array |
| `checkbox: name \| Label` | a single box; `data.name` is `true` or `false` |
| `hidden: name \| value` | a fixed value sent along |
| `submit: Approve, Reject` | the buttons (default: one `Send`); the pressed one is `action` |

Any other line is help text (inline markdown).

**Options with explanations.** When the options of a choice need saying
what they mean, put each on its own line under the field, as
`- label | what choosing it means` (both inline markdown; the label's plain
text is what is sent). Each shows as a row to pick, its explanation beside
it; `*` marks the writer's recommendation, tagged as such. Nothing starts
selected: a choice is made only by picking it, so a send without a pick
leaves it open (`null` for a radio, `[]` for checkboxes), as when the reader
only asks a question in a notes field. Treat such an answer as a question,
not a decision. Use this for decisions instead of explaining the options
elsewhere on the page.

````markdown
```form storage
radio: where | Where answers are kept
- *One log per project | Simple, and the agent waits on one file.
- One log per page | Pages can be moved with their answers.
submit: Send
```
````

```form storage
radio: where | Where answers are kept
- *One log per project | Simple, and the agent waits on one file.
- One log per page | Pages can be moved with their answers.
submit: Send
```

````markdown
```form deploy-review
Ship **v2.3** to production?
radio: env | Target | staging, *production
textarea: notes | Notes | anything to check first
submit: Approve, Hold
```
````

```form deploy-review
Ship **v2.3** to production?
radio: env | Target | staging, *production
textarea: notes | Notes | anything to check first
submit: Approve, Hold
```

**A thread under every form.** The reader can ask about a question without
answering it: what they write in the form's thread is a `thread` event,
`{ "form": "<name>", "text": "…" }`, never a submit of the form, so it never
makes a choice. Answer in the same thread:

```sh
whiteboard append --page <file> --type thread --data '{"form":"<name>","text":"your answer"}'
```

The thread shows as a chat, the reader's messages on one side and yours on
the other. Two more fields, both optional:

- `replyTo`: the id of a submit of this form whose written text you answer
  (a remark typed into one of its text fields). That text shows as the
  reader's message, right before yours.
- `replaces`: the id of an earlier message of yours. Yours takes its place,
  to correct it; the log itself only grows.

Your messages show as the agent's, and `wait` and `watch` skip what you
append. A wait on the whole page (no `--type`) hands out thread messages too;
a wait with `--type <form name>` does not. So don't add a free-text field
for questions or remarks to a decision form: the thread is for that, and a
submit stays a choice.

A hand-written `<form name="…">` (no `action` attribute) is recorded the same
way; this template only saves typing.
