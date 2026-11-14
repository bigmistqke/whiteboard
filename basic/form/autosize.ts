// A textarea that grows with its text, between a minimum and a maximum number of rows. Inlined
// from solid-textarea-autosize (MIT, © 2022 bigmistqke), itself a port of react-textarea-autosize,
// and updated for Solid 2: a ref directive, set up in `onSettled` with its cleanup returned.
//
//   <textarea ref={autosize({ maxRows: 8 })} />
//
// The height is measured on a hidden textarea with the same sizing styles. It is measured again on
// every input, and whenever the textarea's own box changes (a narrower pane wraps more lines).
// After changing the value from code, dispatch an `input` event to measure again.
import { onSettled } from 'solid-js'

export interface AutosizeOptions {
  /** rows shown at the least (default 1) */
  minRows?: number
  /** rows it grows to at the most, then it scrolls (default: no limit) */
  maxRows?: number
}

const SIZING_STYLE = [
  'border-bottom-width', 'border-left-width', 'border-right-width', 'border-top-width', 'box-sizing',
  'font-family', 'font-size', 'font-style', 'font-weight', 'letter-spacing', 'line-height',
  'padding-bottom', 'padding-left', 'padding-right', 'padding-top', 'tab-size', 'text-indent',
  'text-rendering', 'text-transform', 'width', 'word-break',
] as const

// forced on the measuring textarea, over anything a page's stylesheet gives textareas (a page's
// `max-width: 100%` resolves against the body here, and would squeeze it to nothing)
const HIDDEN_STYLE: Record<string, string> = {
  'min-height': '0', 'max-height': 'none', 'min-width': '0', 'max-width': 'none', height: '0',
  visibility: 'hidden', overflow: 'hidden',
  position: 'absolute', 'z-index': '-1000', top: '0', right: '0',
}

interface Sizing { style: Record<string, string>; padding: number; border: number }

function sizingOf(node: HTMLElement): Sizing | null {
  const computed = getComputedStyle(node)
  const style: Record<string, string> = {}
  for (const key of SIZING_STYLE) style[key] = computed.getPropertyValue(key)
  // a node that is not in the document has no computed box
  if (!style['box-sizing']) return null
  return {
    style,
    padding: parseFloat(style['padding-bottom']) + parseFloat(style['padding-top']),
    border: parseFloat(style['border-bottom-width']) + parseFloat(style['border-top-width']),
  }
}

let hidden: HTMLTextAreaElement | null = null

/** The height the textarea needs for `value`, within the rows allowed. */
function heightFor(sizing: Sizing, value: string, minRows: number, maxRows: number) {
  if (!hidden) {
    hidden = document.createElement('textarea')
    hidden.setAttribute('tabindex', '-1')
    hidden.setAttribute('aria-hidden', 'true')
  }
  if (!hidden.isConnected) document.body.append(hidden)
  for (const [key, value] of Object.entries(sizing.style)) hidden.style.setProperty(key, value)
  for (const [key, value] of Object.entries(HIDDEN_STYLE)) hidden.style.setProperty(key, value, 'important')

  const borderBox = sizing.style['box-sizing'] === 'border-box'
  // border-box: the height includes padding and border; content-box: only the content
  const outer = (content: number) => (borderBox ? content + sizing.padding + sizing.border : content)
  hidden.value = value
  const height = borderBox ? hidden.scrollHeight + sizing.border : hidden.scrollHeight - sizing.padding
  hidden.value = 'x'
  const row = hidden.scrollHeight - sizing.padding
  return Math.min(outer(row * maxRows), Math.max(outer(row * minRows), height))
}

/** A ref directive that keeps a textarea as tall as its text. */
export function autosize(options: AutosizeOptions = {}) {
  let node: HTMLTextAreaElement | undefined
  let last = 0
  const resize = () => {
    if (!node) return
    const sizing = sizingOf(node)
    if (!sizing) return
    const height = heightFor(sizing, node.value || node.placeholder || 'x', options.minRows ?? 1, options.maxRows ?? Infinity)
    if (height === last) return
    last = height
    node.style.setProperty('height', `${height}px`, 'important')
  }
  // the ref runs before the element is in the document: measure once it is
  onSettled(() => {
    const el = node
    if (!el) return
    resize()
    el.addEventListener('input', resize)
    const observer = new ResizeObserver(() => resize())
    observer.observe(el)
    return () => {
      el.removeEventListener('input', resize)
      observer.disconnect()
    }
  })
  return (el: HTMLTextAreaElement) => {
    node = el
  }
}
