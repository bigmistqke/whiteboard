Syntax highlighting for code blocks. [Shiki](https://shiki.style) runs on the server, so no script
runs on the page, and the colours follow the page theme. It applies to every
fence that no other block claims by name, and to the code view of
repository files. Write an ordinary fence with a language:

````markdown
```ts
const page = await whiteboard.show('plan')
```
````

```ts
const page = await whiteboard.show('plan')
```

A `diff` fence (what `git diff` or `diff -u` prints) tints each line by
what it is: added, removed, a hunk's header. Each line in a hunk also says
where it is from (`src/a.ts:12`), and a comment on it records that. Use four
backticks around it, since a diff can hold three.

A missing or unknown language renders as plain text. Fences named after
another block, such as `mermaid`, still go to that block.

It's a built-in plugin. For options, replace it in the config with your own
`code(…)`:

```ts
import code from '@bigmistqke/whiteboard/code'

export default defineConfig({
  plugins: [code({
    themes: { light: 'github-light', dark: 'github-dark' },          // any Shiki theme names
    colorReplacements: { 'github-light': { '#e36209': '#0f766e' } }, // per theme
  })],
})
```

Without options it uses the GitHub themes, with their oranges swapped for a
teal that fits the default palette. If you pass `themes`, nothing is swapped
unless you also pass `colorReplacements`.
