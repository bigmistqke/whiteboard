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

A grid card whose heading ends in a badge shows it at the card's right edge.

### Parser :badge[done]

| step | state |
| --- | --- |
| parse | :badge[done] |
| render | :badge[active] |
| docs | :badge[todo] |

The release is :badge[blocked] on review.
