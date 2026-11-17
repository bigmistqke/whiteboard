Content that is never marked as new. Changed blocks get a red bar until the
reader has seen them; what is inside `quiet` does not count as a change. Use
it for what changes without being news to the reader: repeating back what
they answered, a status line, a timestamp. Anything with substance (an
explanation, a question back, a different reading of their answer) belongs
outside it, so it is marked.

A whole block, a line, or a few words:

```markdown
:::quiet
Decided: **this week**, as you answered.
:::

::quiet[Last checked 12:04]

The build is green :quiet[(as of 12:04)].
```

Inside a larger block, such as a card, only the quiet part is ignored: other
changes in the block still mark it. Hand-written HTML can do the same with a
`data-wb-quiet` attribute.

:::quiet
This block is quiet: editing it never marks it as new.
:::
