// Icons the page and the server both draw, as SVG markup. No Node in it: the browser runtime
// imports it too.

/** An inbox: what awaits the reader (the header's menu, the overview). */
export const INBOX_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2 9.5 3.8 3.2A1 1 0 0 1 4.8 2.5h6.4a1 1 0 0 1 1 .7L14 9.5V13a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 2 13Zm0 0h3.5l1 1.5h3l1-1.5H14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>'

/** "Awaiting you: 2 questions", and where: what the inbox says to a reader who hovers it. */
export const awaitingLabel = (n: number, where = '') => `Awaiting you: ${n} question${n === 1 ? '' : 's'}${where}`
