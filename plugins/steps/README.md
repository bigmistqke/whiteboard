One pane, one item at a time, with ‹ › between them: an A/B, the steps of a
procedure, versions of a design. It is a window, so ⤢ fills the browser
window with it (for going through steps, large).

Each heading at the shallowest level starts an item; without headings, `---`
separates them. With up to four items, all titled, the header shows the
titles as tabs; else it counts (`2 / 5`) and each item shows its title.

The items are laid over each other, so the pane is as tall as the tallest
and flipping doesn't move the page. ← and → step when it has the focus (a
click in it) or fills the window. Which item shows stays when the page
updates.

Attributes: `count` (count, never tabs), `wide`, `height`.

```markdown
:::steps[Two headers]
### A
The label on the left, the buttons on the right.

### B
Everything centred.
:::
```

:::steps[Two headers]
### A
The label on the left, the buttons on the right.

### B
Everything centred.
:::

```markdown
:::steps[The migration]
### Copy the table
`migrate --dry-run` on staging first.

### Switch the reads
…
:::
```
