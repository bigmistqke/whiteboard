A table of contents beside the page, from its `##` and `###` headings,
numbered as the page numbers them. The section being read is marked, a click
goes to a section, and a section with an unanswered question or an unread
message has a dot. It sits in the margin left of the text when the window has
room; else a button in the header opens it. Opt in, in the config:

```ts
import toc from '@bigmistqke/whiteboard/toc'
export default defineConfig({ plugins: [toc()] })
```

A page has it when its frontmatter says `toc: true`:

```markdown
---
toc: true
---
# A long page
```

To have it on every page, `toc({ always: true })`; a page then goes without
with `toc: false`.

The panel fits its items, between a minimum and a maximum width (160px and
320px by default). A project sets its own in the options, and a page in its
frontmatter, which is then also how it asks for the contents:

```ts
toc({ minWidth: 180, maxWidth: '24rem' })   // pixels, or a CSS length
```

```markdown
---
toc:
  maxWidth: 240px
---
```
