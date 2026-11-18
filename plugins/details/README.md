A collapsible section. The label is the summary line; the body is any
markdown. Use it to keep in-depth explanation out of the way of the main read.
Unlike a raw `<details>` tag, the body needs no blank-line care. While it
is open, its title stays at the top as you scroll through it, and the title
of a details inside it stacks below.

Attributes: `open` (start expanded).

```markdown
:::details[Why remark-directive instead of MDX?]
MDX fails the **whole page** on one stray `<` or `{`. Directives that no
block handles still render as plain markdown.
:::
```

:::details[Why remark-directive instead of MDX?]
MDX fails the **whole page** on one stray `<` or `{`. Directives that no
block handles still render as plain markdown.
:::
