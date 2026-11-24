// Whether each code block overflows sideways, measured, so style.css can choose its scrollbar in
// advance: `data-overflow="true"` gives the code `overflow-x: scroll`, `"false"` `overflow-x: hidden`.
//
// Why: WebKit defers the scrollbar of an `overflow-x: auto` element while a flex or grid ancestor
// is laid out. Once the outermost flex/grid layout is done, it adds the scrollbar and lays out only
// the scroller again, so every ancestor keeps the height it had without the bar: the bar hangs
// below the block's background, over what follows. Whiteboard's chat (flex), forms and grid cards
// (grid) put code blocks right there. Reading a size afterwards doesn't fix it (to WebKit the
// ancestors are laid out already), nor does a wrapper (it is one more ancestor that keeps its
// height). A scrollbar chosen in style is laid out with the ancestors.
//
//   - block/buzz-app#1677, the same bug for tables in chat messages, traced into WebKit's source
//     (RenderBlock::endAndCommitUpdateScrollInfoAfterLayoutTransaction →
//     relayoutRenderBlockForScrollbarChange, MarkOnlyThis), and this fix:
//     https://github.com/block/buzz-app/pull/1677
//   - WebKit bug 51148, overflow: auto not accounting for its scrollbars after a size change:
//     https://bugs.webkit.org/show_bug.cgi?id=51148
//   - WebKit source, where the deferred scrollbar update is committed:
//     https://github.com/WebKit/WebKit/blob/main/Source/WebCore/rendering/RenderBlock.cpp
//
// Always `overflow-x: scroll` would do without measuring, but leaves an empty scrollbar track
// under every block that fits wherever scrollbars take space (macOS set to always show them).
//
// Measured when a block arrives (before the browser lays it out: a MutationObserver's callback
// runs before the next layout), when it changes size, and when its text changes: a block at its
// widest can start or stop overflowing without changing size. Blocks nothing measured (a page
// without scripts) keep `overflow-x: auto`.
import type { PluginMount } from '../../src/define.ts'

const CODE = 'pre.shiki > code'

const mount: PluginMount = root => {
  const measure = (code: HTMLElement) => {
    // a scrollbar of its own leaves clientWidth as it was: this reads the same either way
    const overflow = String(code.scrollWidth > code.clientWidth)
    if (code.dataset.overflow !== overflow) code.dataset.overflow = overflow
  }
  const sizes = new ResizeObserver(entries => {
    for (const { target } of entries) measure(target as HTMLElement)
  })
  const known = new WeakSet<HTMLElement>()
  const arrive = (within: Element) => {
    const codes = within.matches(CODE) ? [within as HTMLElement] : within.querySelectorAll<HTMLElement>(CODE)
    for (const code of codes) {
      measure(code)
      if (known.has(code)) continue
      known.add(code)
      sizes.observe(code)
    }
  }
  arrive(root)
  // a font that loads after a block was measured widens its text without resizing the block or
  // changing its content: measured again, else one marked as fitting would clip what it can't show
  document.fonts?.addEventListener('loadingdone', () => {
    for (const code of root.querySelectorAll<HTMLElement>(CODE)) measure(code)
  })
  // what arrives later (a chat message, a page's update), and text changing inside a block; the
  // attribute itself is not watched, so setting it never comes back here
  new MutationObserver(records => {
    for (const r of records) {
      if (r.type === 'characterData') {
        const code = r.target.parentElement?.closest<HTMLElement>(CODE)
        if (code) measure(code)
        continue
      }
      for (const n of r.addedNodes) if (n instanceof Element) arrive(n)
      const code = r.target instanceof Element ? r.target.closest<HTMLElement>(CODE) : null
      if (code) measure(code)
    }
  }).observe(root, { childList: true, characterData: true, subtree: true })
}

export default mount
