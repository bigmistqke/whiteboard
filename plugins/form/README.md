A named form, written as markdown. Submitting it appends
`{ id, ts, page, type, action, data }` to the events log, where `type` is the
form's `name`, `action` is the button that was pressed and `data` holds the
inputs. The form starts from its last answer.

The body of `:::form{name=…}` is ordinary markdown, and inputs are inline
directives that can sit anywhere in it: in a paragraph, a list, a table
cell, a heading, a grid card. So a question sits with everything that
explains it.

| input | written as | sends |
| --- | --- | --- |
| one choice | `:radio[This week]{name=when}` per option | the picked label's text, or `null` |
| several choices | `:check[Android]{name=phones}` per option | an array of the checked labels |
| one checkbox | `:check[I read it]{name=read}` | `true` or `false` |
| text | `:text[Title]{name=title placeholder="a short name"}` | the text |
| more text | `:textarea[Notes]{name=notes}` | the text |
| number, date, range | `:number[Count]{name=count min=0 max=10}`, `:date[Due]{name=due}`, `:range[…]{name=… min=0 max=100}` | the value |
| dropdown | `:select[Target]{name=env options="staging, production"}` | the picked option |
| fixed value | `:hidden{name=version value=2.3}` | the value |
| buttons | `:button[Approve]` `:button[Hold]` | which one is `action` |

- The label in `[…]` is markdown. An option sends its label as plain text
  (`:radio[This **week**]` sends `This week`), unless `value=…` says what
  to send instead.
- `recommended` tags an option as the writer's recommendation; it is never
  preselected, so a choice is only made by picking it. `checked` does
  preselect one; use it for defaults, not for decisions.
- Without a `:button`, the form gets one `Send` button. The first button is
  the primary one.
- `value=…` on `:text`, `:textarea`, `:select` and the others sets what
  they start with.

**Options with what they mean.** When the options of a decision need
explaining, put each one at the start of a list item, with its explanation
under it. Such an item reads as a row to pick:

````markdown
:::form{name=storage}
**Where are answers kept?**

- :radio[One log per project]{name=where recommended}
  Simple, and the agent waits on one file.
- :radio[One log per page]{name=where}
  Pages can be moved with their answers.
:::
````

:::form{name=storage}
**Where are answers kept?**

- :radio[One log per project]{name=where recommended}
  Simple, and the agent waits on one file.
- :radio[One log per page]{name=where}
  Pages can be moved with their answers.
:::

An option's explanation can be any markdown: a code block, a table, a
picture, a `:::details` block. Indent it under the item, and mind the
colons: a container inside the form needs fewer colons than the form, so
write the form as `::::form` around a `:::details`.

**Inputs anywhere.** Since an input is a word-sized element, any layout
can hold one: a card per option in a grid, a checkbox per row of a table.

````markdown
::::form{name=deploy-review}
Ship **v2.3** to production?

:::grid{cols=2}
### :radio[Staging]{name=env}
Runs the migration on a copy first.

### :radio[Production]{name=env recommended}
The migration is reversible.
:::

:textarea[Notes]{name=notes placeholder="anything to check first"}

:button[Approve] :button[Hold]
::::
````

::::form{name=deploy-review}
Ship **v2.3** to production?

:::grid{cols=2}
### :radio[Staging]{name=env}
Runs the migration on a copy first.

### :radio[Production]{name=env recommended}
The migration is reversible.
:::

:textarea[Notes]{name=notes placeholder="anything to check first"}

:button[Approve] :button[Hold]
::::

Forms don't nest, and inputs belong inside a form: outside one they show
but send nothing.

**A chat under every form.** The reader can ask about a question without
answering it: under every form is a chat (see the chat plugin), named
after the form, whose messages are never a submit, so talking about a choice
never makes it. Answer there with `whiteboard append --type chat:message
--data '{"chat":"<form name>","text":"…"}'`, and don't add a free-text field
for questions to a decision form.

A hand-written `<form name="…">` (no `action` attribute) is recorded the same
way; this block only saves typing.
