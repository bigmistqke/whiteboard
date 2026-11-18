Composed around a container, the pictures in it open large on a click: ← →
(or ‹ ›) step through the container's pictures and videos, Esc or a click
beside it closes. A picture that is a link keeps going to its link, and a
video is not opened by a click (that plays it), but takes part in the
stepping.

```markdown
:::grid{min=200px compose=lightbox}
### Dunes
::image{src="dunes.jpg" alt="Dunes at dusk"}
Option A: warm, quiet.

### Coast
::image{src="coast.jpg"}
Option B: more contrast.
:::
```

That is a gallery: a grid, and a lightbox around it. It goes around any
container (a window, steps, a list of pictures), and with other parts:
`compose=lightbox,window`. A picture's caption in the lightbox is its alt
text (an `::image`'s label).
