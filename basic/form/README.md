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

A hand-written `<form name="…">` (no `action` attribute) is recorded the same
way; this template only saves typing.
