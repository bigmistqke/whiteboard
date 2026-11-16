// Named forms, as a whiteboard extension: on every page, whatever renderer drew it, a
// `<form name>` without an `action` sends a submit as an event whose type is the form's name, keeps
// drafts until it is sent, gets its last answer back, and shows what an agent waits for. In a
// config:
//
//   import forms from '@bigmistqke/whiteboard/forms'
//   export default defineConfig({ renderers: [markboard()], extensions: [forms()] })
//
// Which forms a page asks (for `whiteboard status`) stays the renderer's to say (`expects`): only it
// can read its own syntax. Everything here is in the browser (client.ts); this file wires it in.
import { html } from '../src/html.js'

const CLIENT = new URL('../dist/forms/client.js', import.meta.url)
const STYLE = new URL('../dist/forms/style.css', import.meta.url)

export default function forms() {
  return {
    name: 'forms',
    setup(ctx) {
      const style = ctx.asset(STYLE)
      return {
        client: CLIENT,
        // before the renderer's own styles would be better, but the shell's head comes after them:
        // a renderer that wants its own look overrides with a more specific selector
        shell: () => ({ head: html`<link rel="stylesheet" href="${style}">` }),
      }
    },
  }
}
