// Comments on a page's text, on every page. The reader selects a passage
// of the page's content (its <main>, else all of it), a "Comment" button appears next to it,
// and what they write goes into the page's log; the agent replies there too (`whiteboard append`),
// or edits the page. Threads stay until the reader closes them. In a code block, the reader can
// also comment on whole lines: a "+" beside the line, pressed, or dragged over several.
//
// Everything is an event on the page, its type named after the plugin:
//   comments:new      { quote, before, after, block, at?, text }   the event's id is the thread's id
//   comments:reply    { replyTo, text }                       from the reader, or from the command line
//   comments:resolve  { replyTo }                             the reader closed the thread
//
// A block can say where its parts are from with `data-wb-at` (a diff's lines: `src/a.ts:12`); a
// comment records those of the passage as `at` (the first, and the last when it differs), so the
// agent knows what it is about.
//
// Passages are found again by their quote and the text around it, so they survive edits elsewhere
// on the page, and highlighted with the CSS Highlight API: the page's own markup is never touched,
// so updates and new-content marks don't see comments at all.
import type { Api, PluginMount, PageHandle, WbEvent } from '../../src/define'
import { html } from '../../src/html.ts'

const NEW = 'comments:new', REPLY = 'comments:reply', RESOLVE = 'comments:resolve'

interface Thread {
  id: string
  comment: WbEvent
  replies: WbEvent[]
  range: Range | null
}

const CONTEXT = 32

let root: HTMLElement
let api: Api
// the page's content: its <main> when it has one. Looked up afresh, since a live update may replace it
let main: HTMLElement
let threads: Thread[] = []
let openThread: string | null = null

const layer = document.createElement('div')
layer.className = 'wb-comments'

const startButton = document.createElement('button')
startButton.type = 'button'
startButton.className = 'wb-comment-start'
startButton.textContent = 'Comment'
startButton.hidden = true

const popover = document.createElement('div')
popover.className = 'wb-thread'
popover.hidden = true

// ---- the page's text ---------------------------------------------------------------------------

/** The text of the page's content as one string, with where each text node starts in it. */
function textIndex() {
  const nodes: { node: Text; start: number }[] = []
  let text = ''
  const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT, {
    acceptNode: n => (n.parentElement?.closest('script, style, textarea') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  })
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    nodes.push({ node: n, start: text.length })
    text += n.data
  }
  return { text, nodes }
}

/** A position in the index → the text node and offset in it. */
function point(index: ReturnType<typeof textIndex>, at: number, end: boolean) {
  for (let i = 0; i < index.nodes.length; i++) {
    const { node, start } = index.nodes[i]
    const stop = start + node.data.length
    if (at < stop || (end && at === stop) || i === index.nodes.length - 1) return { node, offset: Math.min(Math.max(at - start, 0), node.data.length) }
  }
  return null
}

/** Where a range starts and ends in the index. */
function offsetsOf(index: ReturnType<typeof textIndex>, range: Range) {
  const find = (container: Node, offset: number) => {
    if (container.nodeType === Node.TEXT_NODE) {
      const hit = index.nodes.find(n => n.node === container)
      return hit ? hit.start + offset : null
    }
    // an element boundary: the end of the last text node before it
    const prefix = document.createRange()
    prefix.setStart(main, 0)
    prefix.setEnd(container, offset)
    let at = 0
    for (const { node, start } of index.nodes) if (prefix.intersectsNode(node)) at = start + node.data.length
    return at
  }
  const start = find(range.startContainer, range.startOffset)
  const end = find(range.endContainer, range.endOffset)
  return start == null || end == null ? null : { start, end }
}

/** The passage of a comment on the page as it is now: its quote, the occurrence whose surroundings match best. */
function locate(index: ReturnType<typeof textIndex>, data: Record<string, unknown>): Range | null {
  const quote = String(data.quote ?? '')
  if (!quote) return null
  const before = String(data.before ?? ''), after = String(data.after ?? '')
  let best = -1, bestScore = -1
  for (let at = index.text.indexOf(quote); at >= 0; at = index.text.indexOf(quote, at + 1)) {
    const b = index.text.slice(Math.max(0, at - before.length), at)
    const a = index.text.slice(at + quote.length, at + quote.length + after.length)
    let score = 0
    while (score < b.length && b[b.length - 1 - score] === before[before.length - 1 - score]) score++
    let s2 = 0
    while (s2 < a.length && a[s2] === after[s2]) s2++
    if (score + s2 > bestScore) { best = at; bestScore = score + s2 }
  }
  if (best < 0) return null
  const s = point(index, best, false), e = point(index, best + quote.length, true)
  if (!s || !e) return null
  const range = document.createRange()
  range.setStart(s.node, s.offset)
  range.setEnd(e.node, e.offset)
  return range
}

// ---- threads -----------------------------------------------------------------------------------

function collect(): Thread[] {
  const events = api.events()
  const resolved = new Set(events.filter(e => e.type === RESOLVE).map(e => String(e.data.replyTo)))
  const index = textIndex()
  return events
    .filter(e => e.type === NEW && !resolved.has(e.id))
    .map(comment => ({
      id: comment.id,
      comment,
      replies: events.filter(e => e.type === REPLY && e.data.replyTo === comment.id),
      range: locate(index, comment.data),
    }))
}

const lastFromAgent = (t: Thread) => t.replies.at(-1)?.from === 'cli'

/** Highlight every open thread's passage, and put its badge in the margin beside it. */
function draw() {
  const highlights = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
  const HighlightCtor = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight
  if (highlights && HighlightCtor) {
    highlights.set('wb-comment', new HighlightCtor(...threads.filter(t => t.range && t.id !== openThread).map(t => t.range!)))
    const active = threads.find(t => t.id === openThread)?.range
    if (active) highlights.set('wb-comment-active', new HighlightCtor(active))
    else highlights.delete('wb-comment-active')
  }
  const column = main.getBoundingClientRect()
  layer.replaceChildren(...threads.map((t, i) => {
    const badge = document.createElement('button')
    badge.type = 'button'
    badge.className = 'wb-comment-badge'
    badge.dataset.thread = t.id
    badge.toggleAttribute('data-agent', lastFromAgent(t))
    badge.title = lastFromAgent(t) ? 'the agent replied' : 'comment'
    badge.textContent = String(1 + t.replies.length)
    const rect = t.range?.getClientRects()[0]
    // a passage that is gone from the page: its badge waits at the top, still open until closed
    const top = rect ? rect.top + scrollY : column.top + scrollY + i * 30
    const left = Math.min(column.right + 8 + scrollX, document.documentElement.clientWidth - 36 + scrollX)
    badge.style.top = `${top}px`
    badge.style.left = `${left}px`
    if (!rect) badge.dataset.detached = ''
    return badge
  }))
  if (openThread) placePopover()
}

/** Called after the page re-rendered, and whenever the log changed. */
function refreshComments() {
  if (!root) return
  main = root.querySelector('main') ?? root
  threads = collect()
  if (openThread && !threads.some(t => t.id === openThread)) closePopover()
  else if (openThread) renderPopover()
  draw()
}

// ---- the thread popover ------------------------------------------------------------------------

function renderPopover() {
  const t = threads.find(x => x.id === openThread)
  if (!t) return
  const who = (e: WbEvent) => (e.from === 'cli' ? 'agent' : 'you')
  // the quote and every message are text from the reader or the agent: `html` escapes them
  const message = (e: WbEvent) =>
    html`<div class="wb-thread-message" data-from="${who(e)}"><span class="wb-thread-who">${who(e)}</span><div class="wb-thread-text">${e.data.text ?? ''}</div></div>`
  const draft = popover.querySelector('textarea')?.value ?? ''
  popover.innerHTML = String(html`
    <blockquote class="wb-thread-quote">${t.comment.data.quote ?? ''}</blockquote>
    ${t.comment.data.at && html`<p class="wb-thread-at">${t.comment.data.at}</p>`}
    ${!t.range && html`<p class="wb-thread-detached">This passage is no longer on the page.</p>`}
    ${[t.comment, ...t.replies].map(message)}
    <form class="wb-thread-reply">
      <textarea rows="2" placeholder="Reply"></textarea>
      <div class="wb-thread-actions"><button type="submit" class="wb-comment-button wb-comment-primary">Reply</button><button type="button" class="wb-comment-button" data-close>Close thread</button></div>
    </form>`)
  popover.querySelector('textarea')!.value = draft
}

function placePopover() {
  const badge = layer.querySelector<HTMLElement>(`[data-thread="${openThread}"]`)
  if (!badge) return
  const top = parseFloat(badge.style.top) + 28
  const width = Math.min(360, document.documentElement.clientWidth - 32)
  const left = Math.max(16 + scrollX, Math.min(parseFloat(badge.style.left) + 28 - width, document.documentElement.clientWidth - width - 16 + scrollX))
  popover.style.top = `${top}px`
  popover.style.left = `${left}px`
  popover.style.width = `${width}px`
}

function openPopover(id: string) {
  openThread = id
  popover.hidden = false
  popover.querySelector('textarea')?.replaceWith(document.createElement('textarea'))
  renderPopover()
  draw()
  popover.querySelector('textarea')?.focus({ preventScroll: true })
}

function closePopover() {
  openThread = null
  popover.hidden = true
  draw()
}

// ---- starting a comment ------------------------------------------------------------------------

let pending: { quote: string; before: string; after: string; block: number; at?: string } | null = null

/** A selection inside the page's text (not in a form) → where the Comment button goes. */
function onSelection() {
  main = root.querySelector('main') ?? root
  const sel = getSelection()
  if (!sel || sel.isCollapsed || !sel.rangeCount) { if (!startButton.matches(':focus')) startButton.hidden = true; return }
  const range = sel.getRangeAt(0)
  const inPage = (n: Node) => main.contains(n) && !(n instanceof Element ? n : n.parentElement)?.closest('form, input, textarea, select, button')
  if (!inPage(range.startContainer) || !inPage(range.endContainer)) { startButton.hidden = true; return }
  startButton.hidden = !prepare(range)
}

/**
 * What a comment on `range` records (`pending`), and the Comment button put under its end. False
 * when there is nothing to comment on.
 */
function prepare(range: Range): boolean {
  const quote = range.toString().trim()
  if (!quote) return false
  const index = textIndex()
  const at = offsetsOf(index, range)
  if (!at) return false
  // the quote as it appears in the page's text, trimmed of the whitespace the selection had around it
  const start = index.text.indexOf(quote, at.start)
  const s = start >= 0 && start <= at.end ? start : at.start
  let block: Element | null = (range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement)
  while (block && block.parentElement !== main) block = block.parentElement
  pending = {
    quote,
    before: index.text.slice(Math.max(0, s - CONTEXT), s),
    after: index.text.slice(s + quote.length, s + quote.length + CONTEXT),
    block: block ? [...main.children].indexOf(block) : -1,
  }
  // where the passage is from, when its block says (see the top of this file)
  const places = [...main.querySelectorAll<HTMLElement>('[data-wb-at]')].filter(el => range.intersectsNode(el) && el.textContent).map(el => el.dataset.wbAt!)
  if (places.length) pending.at = places.length > 1 && places.at(-1) !== places[0] ? `${places[0]} – ${places.at(-1)}` : places[0]
  const rects = range.getClientRects()
  const last = rects[rects.length - 1] ?? range.getBoundingClientRect()
  startButton.style.top = `${last.bottom + scrollY + 6}px`
  startButton.style.left = `${Math.min(last.right + scrollX - 40, document.documentElement.clientWidth - 110 + scrollX)}px`
  return true
}

// ---- comments on lines of code -----------------------------------------------------------------

// A code block's lines (Shiki writes each as a .line): hovering one shows "+" at its left; pressing
// it comments on the line, dragging it down or up takes the lines it passes over.
const lineButton = document.createElement('button')
lineButton.type = 'button'
lineButton.className = 'wb-line-comment'
lineButton.textContent = '+'
lineButton.title = 'Comment on this line (drag for several)'
lineButton.hidden = true

let hovered: HTMLElement | null = null
let drag: { pre: HTMLElement; from: HTMLElement; to: HTMLElement } | null = null

const codeLine = (el: EventTarget | null) => {
  const line = el instanceof Element ? el.closest<HTMLElement>('pre .line') : null
  return line && main.contains(line) && !line.closest('form') ? line : null
}

/** The lines from `a` to `b`, either way round, as one range. */
function linesRange(a: HTMLElement, b: HTMLElement): Range {
  const [first, last] = a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING ? [b, a] : [a, b]
  const range = document.createRange()
  range.setStart(first, 0)
  range.setEnd(last, last.childNodes.length)
  return range
}

function showLineButton(line: HTMLElement) {
  hovered = line
  const rect = line.getBoundingClientRect()
  const pre = line.closest('pre')!.getBoundingClientRect()
  lineButton.style.top = `${rect.top + scrollY + rect.height / 2 - 10}px`
  lineButton.style.left = `${Math.max(scrollX + 2, pre.left + scrollX - 24)}px`
  lineButton.hidden = false
}

function onLinePointer(e: MouseEvent) {
  if (drag) {
    // the line at the pointer's height, inside the block the drag started in
    const pre = drag.pre.getBoundingClientRect()
    const x = drag.from.getBoundingClientRect().left + 4
    const line = codeLine(document.elementFromPoint(x, Math.min(Math.max(e.clientY, pre.top + 1), pre.bottom - 1)))
    if (line && drag.pre.contains(line) && line !== drag.to) {
      drag.to = line
      const highlights = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
      const HighlightCtor = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight
      if (highlights && HighlightCtor) highlights.set('wb-comment-active', new HighlightCtor(linesRange(drag.from, drag.to)))
    }
    return
  }
  if (e.target === lineButton) return
  const line = codeLine(e.target)
  if (line) return showLineButton(line)
  if (lineButton.hidden || !hovered) return
  // on the way from the line to its "+" (through the block's padding): keep it, as long as the
  // pointer stays in the band from the "+" to the line's end
  const band = hovered.getBoundingClientRect()
  const plus = lineButton.getBoundingClientRect()
  const inBand = e.clientX >= plus.left - 4 && e.clientX <= band.right
    && e.clientY >= Math.min(band.top, plus.top) - 4 && e.clientY <= Math.max(band.bottom, plus.bottom) + 4
  if (!inBand) { lineButton.hidden = true; hovered = null }
}

const composer = document.createElement('form')
composer.className = 'wb-thread wb-comment-new'
composer.hidden = true
composer.innerHTML = String(html`<blockquote class="wb-thread-quote"></blockquote><textarea rows="3" placeholder="Your comment"></textarea>
  <div class="wb-thread-actions"><button type="submit" class="wb-comment-button wb-comment-primary">Comment</button><button type="button" class="wb-comment-button" data-cancel>Cancel</button></div>`)

function startComment() {
  if (!pending) return
  composer.querySelector('blockquote')!.textContent = pending.at ? `${pending.at}\n${pending.quote}` : pending.quote
  composer.style.top = startButton.style.top
  const width = Math.min(360, document.documentElement.clientWidth - 32)
  composer.style.width = `${width}px`
  composer.style.left = `${Math.max(16 + scrollX, Math.min(parseFloat(startButton.style.left), document.documentElement.clientWidth - width - 16 + scrollX))}px`
  composer.hidden = false
  startButton.hidden = true
  composer.querySelector('textarea')!.focus({ preventScroll: true })
}

// ---- entry -------------------------------------------------------------------------------------

const mount: PluginMount = (el: HTMLElement, handle: PageHandle, core: Api) => {
  // the overview and folders are lists, not text to comment on
  if (handle.kind !== 'page' && handle.kind !== 'file') return
  root = el
  main = root.querySelector('main') ?? root
  api = core
  document.body.append(layer, startButton, lineButton, popover, composer)

  document.addEventListener('mousemove', onLinePointer)
  lineButton.addEventListener('mousedown', e => {
    if (!hovered || e.button !== 0) return
    e.preventDefault()
    const highlights = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
    const HighlightCtor = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight
    if (highlights && HighlightCtor) highlights.set('wb-comment-active', new HighlightCtor(linesRange(hovered, hovered)))
    drag = { pre: hovered.closest('pre')!, from: hovered, to: hovered }
  })
  document.addEventListener('mouseup', () => {
    if (!drag) return
    const { from, to } = drag
    drag = null
    lineButton.hidden = true
    if (prepare(linesRange(from, to))) startComment()
    else draw()
  })

  let selTimer = 0
  document.addEventListener('selectionchange', () => { clearTimeout(selTimer); selTimer = window.setTimeout(onSelection, 150) })
  // keep the selection when the button is pressed
  startButton.addEventListener('mousedown', e => e.preventDefault())
  startButton.addEventListener('click', startComment)

  composer.addEventListener('submit', async e => {
    e.preventDefault()
    const text = composer.querySelector('textarea')!.value.trim()
    if (!text || !pending) return
    const saved = await api.append(NEW, { ...pending, text })
    composer.querySelector('textarea')!.value = ''
    composer.hidden = true
    pending = null
    getSelection()?.removeAllRanges()
    refreshComments()
    openPopover(saved.id)
  })
  composer.querySelector('[data-cancel]')!.addEventListener('click', () => { composer.hidden = true; pending = null })

  layer.addEventListener('click', e => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('[data-thread]')?.dataset.thread
    if (id) (openThread === id ? closePopover() : openPopover(id))
  })
  popover.addEventListener('submit', async e => {
    e.preventDefault()
    const box = popover.querySelector('textarea')!
    const text = box.value.trim()
    if (!text || !openThread) return
    await api.append(REPLY, { replyTo: openThread, text })
    box.value = ''
    refreshComments()
  })
  popover.addEventListener('click', async e => {
    if (!(e.target as HTMLElement).closest('[data-close]') || !openThread) return
    const id = openThread
    closePopover()
    await api.append(RESOLVE, { replyTo: id })
    refreshComments()
  })
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return
    if (!composer.hidden) { composer.hidden = true; pending = null }
    else if (openThread) closePopover()
  })

  api.onEvents(refreshComments)
  api.onRendered(refreshComments)
  new ResizeObserver(() => draw()).observe(root)
  addEventListener('resize', () => draw())
  refreshComments()
}

export default mount
