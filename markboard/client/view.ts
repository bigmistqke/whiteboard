// The part of the window the page is seen in. The core may put something at the bottom of the
// window (the terminal drawer) and says how tall it is in `--wb-inset-bottom`; what is behind it is
// not in view, so measurements of what the reader sees stop above it.

/** The bottom of the visible part of the page, in window coordinates. */
export function viewBottom(): number {
  const inset = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--wb-inset-bottom')) || 0
  return Math.max(0, innerHeight - inset)
}
