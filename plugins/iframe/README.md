Another page inside this one: a running app (a dev server), a deployed
site, or an HTML file next to the pages. A header like a browser window's
shows its label (or, without one, its address), opens it on its own, and fills the window with
it (the same button, or Esc, puts it back). Drag the frame's bottom edge to
make it taller.

Attributes: `src` (required: an http(s) URL, or a path such as `demo.html`
for `.whiteboard/pages/demo.html`), `height` (a number of pixels or a CSS
length, default 480), `wide` (wider than the text column), `bare` (no
header: the frame alone).

```markdown
::iframe[The app as it runs now]{src="http://localhost:5173" height=600 wide}
```

A site that forbids being framed (most large ones do, with
`X-Frame-Options` or `frame-ancestors`) shows as a blank or refused frame;
link to it instead.
