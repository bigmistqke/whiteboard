// Icons the page and the server both draw, as SVG markup. No Node in it: the browser runtime
// imports it too.

/** An inbox: what awaits the reader (the header's menu, the overview). */
export const INBOX_ICON =
  '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2 9.5 3.8 3.2A1 1 0 0 1 4.8 2.5h6.4a1 1 0 0 1 1 .7L14 9.5V13a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 2 13Zm0 0h3.5l1 1.5h3l1-1.5H14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>'

/** An arrow out of a box: open what this names on its own (a project's own overview). */
export const OPEN_ICON =
  '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v3.5a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V5a.5.5 0 0 1 .5-.5h3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'

/** "Awaiting you: 2 things", and where: what the inbox says to a reader who hovers it. */
export const awaitingLabel = (n: number, where = '') =>
  `Awaiting you: ${n === 1 ? '1 question or message' : `${n} questions and messages`}${where}`
