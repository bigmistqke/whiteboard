// Terminal output in a page: an `ansi` fence holds what a program printed, escape codes and all, and
// the page shows it as the terminal did. The text goes through a headless terminal (xterm's, the
// one the terminal plugin keeps its screens in), so what a terminal does with it is what shows:
// colours (16, 256 and true colour), bold, a progress line `\r` writes over, the cursor moving.
// Rendered on the server to plain HTML, so nothing runs on the page and a built site has it too.
import fs from 'node:fs'
import { definePlugin, html, raw, windowFrame, type FenceContext, type Plugin } from '@bigmistqke/whiteboard'
import xtermHeadless from '@xterm/headless'
import xtermSerialize from '@xterm/addon-serialize'
import { builtinPublic } from '../../src/package.ts'

// CommonJS packages: their exports are the default's
const { Terminal } = xtermHeadless
const { SerializeAddon } = xtermSerialize

/** The widest a line is laid out before it wraps, as a terminal would. */
const MAX_COLS = 240
const ESC = '\x1b'

/**
 * Escapes written out as text count as escapes: an agent writing a page often can't put the ESC
 * byte itself in a file, so `\e[31m`, `\x1b[31m`, `\033[31m`, `\u001b[31m` and `^[[31m` are one.
 */
export const unescape = (text: string): string => text.replace(/\\e(?=\[)|\\x1b|\\033|\\u001b|\^\[(?=\[)/gi, ESC)

/** How wide a line shows: its characters, without its escape sequences. */
const shown = (line: string) =>
  [
    ...line
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g, '')
      .split('\r')
      .at(-1)!,
  ].length

/**
 * What the text shows in a terminal as wide as its widest line (up to MAX_COLS), as HTML rows: the
 * serializer's spans, colours inline, text escaped; trailing blank space and blank rows left out.
 */
export async function toHtml(text: string): Promise<string> {
  const input = unescape(text).replace(/\r?\n$/, '')
  const lines = input.split(/\r?\n/)
  const cols = Math.min(MAX_COLS, Math.max(20, ...lines.map(shown)))
  const term = new Terminal({
    cols,
    rows: Math.max(1, lines.length),
    scrollback: 100_000,
    allowProposedApi: true,
    convertEol: true,
  })
  const serializer = new SerializeAddon()
  term.loadAddon(serializer)
  await new Promise<void>(resolve => term.write(input, resolve))
  const out = serializer.serializeAsHTML({ includeGlobalBackground: false })
  term.dispose()
  // the rows, without the wrapper that sets the serializer's own colours and font
  const body = /<pre><div style='[^']*'>([\s\S]*)<\/div><\/pre>/.exec(out)?.[1] ?? ''
  const rows = [...body.matchAll(/<div>([\s\S]*?)<\/div>/g)].map(m =>
    // a row's padding to the terminal's width is no part of the output
    m[1]!
      .replace(/<span><\/span>/g, '')
      .replace(/<span> +<\/span>$/, '')
      .replace(/(<span>[^<]*?) +(<\/span>)$/, '$1$2'),
  )
  while (
    rows.length &&
    !rows
      .at(-1)!
      .replace(/<[^>]+>/g, '')
      .trim()
  )
    rows.pop()
  return rows.map(r => `<span class="wb-ansi-row">${r}</span>`).join('\n')
}

export async function render(ctx: FenceContext) {
  const body = html`<pre class="wb-ansi"><code>${raw(await toHtml(ctx.text))}</code></pre>`
  // a title makes it a terminal window with that label, as `compose=window` would
  const title = ctx.attrs.title
  return title ? windowFrame({ body, label: String(html`${title}`), className: 'wb-ansi-window' }) : body
}

export default function ansi(): Plugin {
  return definePlugin({
    name: 'ansi',
    public: builtinPublic('ansi'),
    blocks: {
      ansi: {
        fence: true,
        html: render,
        style: 'style.css',
      },
    },
    docs: () => fs.readFileSync(new URL('./README.md', import.meta.url), 'utf8'),
  })
}
