Image cards; clicking one opens a lightbox (arrow keys to step, Esc to close).

Each heading at the shallowest level starts an item: the first image under it
is the picture, the heading is the title and the rest is the caption. Without
headings, every image in the block is an item and its alt text the title.
Relative image paths resolve next to the page file.

Attributes: `min` (smallest card width, default `240px`).

```markdown
:::gallery{min=200px}
### Dunes
![dunes](https://picsum.photos/id/1016/800/600)
Option A: warm, quiet.

### Coast
![coast](https://picsum.photos/id/1015/800/600)
Option B: more contrast.
:::
```

:::gallery{min=200px}
### Dunes
![dunes](https://picsum.photos/id/1016/800/600)
Option A: warm, quiet.

### Coast
![coast](https://picsum.photos/id/1015/800/600)
Option B: more contrast.
:::
