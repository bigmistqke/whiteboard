# grid

Cards in a responsive grid. Each heading at the shallowest level inside the
block starts a card; everything under it is the card body (any markdown,
including other templates). Without headings, each paragraph is a card.

A heading that ends in `{word}` gets a badge. `done ok yes good` are green,
`active new info` blue, `open todo maybe warning` amber,
`blocked no bad error` red; any other word is grey.

Attributes: `cols` (target column count on a wide screen, default 3).

```markdown
:::grid{cols=3}
### Parser {done}
remark + remark-directive.

### Islands {active}
Solid components mounted per block.

### Docs {todo}
Live examples on `/_/docs`.
:::
```

:::grid{cols=3}
### Parser {done}
remark + remark-directive.

### Islands {active}
Solid components mounted per block.

### Docs {todo}
Live examples on `/_/docs`.
:::
