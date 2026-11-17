// What a screen snapshot leaves out. The host restores a session's screen in a browser from the
// serialize addon, which writes the screen and most terminal modes back, but not how mouse events
// are encoded. A full-screen program (Claude Code, an editor) asks for SGR encoding (`?1006`) along
// with mouse reporting; restored without it, the browser's terminal sends the wheel in the old
// encoding, the program ignores it, and the page can't scroll until a resize makes the program ask
// again. So the host follows the encoding itself and adds it to the snapshot.
import type { Terminal } from '@xterm/headless'

/** The mouse encodings a program can ask for: UTF-8 (1005), SGR (1006), URXVT (1015). */
const ENCODINGS = [1005, 1006, 1015]

/**
 * Follow the mouse encoding the program on `terminal` asks for. Returns what to append to a
 * serialized screen to restore it: the escape sequence, or '' for the default encoding.
 */
export function followMouseEncoding(terminal: Terminal): () => string {
  let encoding: number | null = null
  const handle = (on: boolean) => (params: (number | number[])[]) => {
    for (const p of params.flat()) {
      if (!ENCODINGS.includes(p)) continue
      if (on) encoding = p
      else if (encoding === p) encoding = null
    }
    // the terminal handles the sequence as it would anyway
    return false
  }
  terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, handle(true))
  terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, handle(false))
  return () => (encoding ? `\x1b[?${encoding}h` : '')
}
