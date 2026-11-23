A status as a coloured dot and a word, inline wherever text goes: in a
heading, a table cell, a list item, a sentence. `done ok yes good` are
green, `active new info` blue, `open todo maybe warning` amber,
`blocked no bad error` red; any other word is grey.

```markdown
### Parser :badge[done]

| step | state |
| --- | --- |
| parse | :badge[done] |
| render | :badge[active] |
| docs | :badge[todo] |

The release is :badge[blocked] on review.
```

A badge that ends a heading sits at its right edge: a page's heading, a grid
card's, a timeline step's. A block of your own can have the same for a title
that isn't a heading, with a `data-wb-title` attribute on it.

### Parser :badge[done]

| step | state |
| --- | --- |
| parse | :badge[done] |
| render | :badge[active] |
| docs | :badge[todo] |

The release is :badge[blocked] on review.
