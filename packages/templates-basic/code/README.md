# code

Syntax highlighting for code blocks. [Shiki](https://shiki.style) runs on the server, so no script
runs on the page, and the colours follow the page theme. It applies to every
fence that no other template claims by name, and to the code view of
repository files. Write an ordinary fence with a language:

````markdown
```ts
const page = await visualize.show('plan')
```
````

```ts
const page = await visualize.show('plan')
```

A missing or unknown language renders as plain text. Fences named after
another template, such as `mermaid`, still go to that template.

In a config, pass options through `basic()`:

```ts
basic({
  code: {
    themes: { light: 'github-light', dark: 'github-dark' },          // any Shiki theme names
    colorReplacements: { 'github-light': { '#e36209': '#0f766e' } }, // per theme
  },
})
```

Without options it uses the GitHub themes, with their oranges swapped for a
teal that fits the default palette. If you pass `themes`, nothing is swapped
unless you also pass `colorReplacements`.
