A table of contents beside the page, from its `##` and `###` headings,
numbered as the page numbers them. The section being read is marked, a click
goes to a section, and a section with an unanswered question or an unread
message has a dot. It sits in the margin left of the text when the window has
room; else a button in the header opens it. Opt in, in the config:

```ts
import toc from '@bigmistqke/whiteboard/toc'
export default defineConfig({ plugins: [toc()] })
```
