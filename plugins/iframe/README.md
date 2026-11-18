Another page inside this one: a running app (a dev server), a deployed
site, or an HTML file next to the pages. Drag the frame's bottom edge to
make it taller. With `compose=window`, it is in a window: a header with its label
(or, without one, its address), a button that opens it on its own, and one
that fills the browser window with it (the same button, or Esc, puts it
back).

Attributes: `src` (required: an http(s) URL, or a path such as `demo.html`
for `.whiteboard/pages/demo.html`), `height` (a number of pixels or a CSS
length, default 480), `compose=window`, `wide` (wider than the text column).

```markdown
::iframe[The app as it runs now]{src="http://localhost:5173" height=600 compose=window wide}
```

A site that forbids being framed (most large ones do, with
`X-Frame-Options` or `frame-ancestors`) shows as a blank or refused frame;
link to it instead.
