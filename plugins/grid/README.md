Cards in a responsive grid, one per item: a heading at the block's
shallowest heading level starts one, titled by it, and so does a `---`,
untitled; everything up to the next is the card body (any markdown,
including other blocks). Content with neither is one card.

A heading that ends in a badge (`:badge[done]`) shows it at the card's
right edge.

Attributes: `cols` (target column count on a wide screen, default 3).

```markdown
:::grid{cols=3}
### Parser :badge[done]
remark + remark-directive.

### Islands :badge[active]
Solid components mounted per block.

### Docs :badge[todo]
Live examples on `/_/docs`.
:::
```

:::grid{cols=3}
### Parser :badge[done]
remark + remark-directive.

### Islands :badge[active]
Solid components mounted per block.

### Docs :badge[todo]
Live examples on `/_/docs`.
:::
