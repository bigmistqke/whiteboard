// The lightbox: composed around a container (`:::grid{compose=lightbox}`), it makes the pictures in
// it open large on a click, and ← → step through the container's pictures and videos. The pictures
// themselves know nothing of it: outside one, a picture is just a picture. It marks the container
// (its outer element gets `data-lightbox`) rather than wrapping it, so the page lays the container
// out as before (a wide grid stays wide); the browser module (client.ts) does the rest.
import fs from 'node:fs'
import { definePlugin, html, raw, type Plugin } from '@bigmistqke/whiteboard'
import { builtinPublic } from '../../src/package.ts'

/** The container's HTML with its outer element marked; around it, when it starts with no element. */
export function mark(children: string): string {
  const marked = children.replace(/^(\s*<[a-zA-Z][\w-]*)(?=[\s>/])/, '$1 data-lightbox')
  return marked !== children ? marked : String(html`<div data-lightbox>${raw(children)}</div>`)
}

export default function lightbox(): Plugin {
  return definePlugin({
    name: 'lightbox',
    public: builtinPublic('lightbox'),
    style: 'style.css',
    compose: ({ children }) => mark(String(children)),
    setup: () => ({ client: 'client.js' }),
    docs: () => fs.readFileSync(new URL('./README.md', import.meta.url), 'utf8'),
  })
}
