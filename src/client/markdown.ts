// Messages written in markdown (comments, chat messages), as HTML: rendered on the server like a
// page (code fences highlighted, `#12` linked), without raw HTML or directives (api.markdown). The
// texts asked for at once go in one request; each text is rendered once, then cached. A
// stylesheet a message needs (the code block's) is linked once it is first used.

const cache = new Map<string, Promise<string>>()
let queue: { text: string; resolve: (html: string) => void; reject: (err: unknown) => void }[] = []

async function flush() {
  const batch = queue
  queue = []
  try {
    const res = await fetch('/api/markdown', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ texts: batch.map(b => b.text) }),
    })
    if (!res.ok) throw new Error(await res.text())
    const { html, styles } = (await res.json()) as { html: string[]; styles: string[] }
    for (const href of styles) {
      if (
        ![...document.querySelectorAll<HTMLLinkElement>('link[rel=stylesheet]')].some(
          l => new URL(l.href).pathname === new URL(href, location.href).pathname,
        )
      )
        document.head.insertAdjacentHTML('beforeend', `<link rel="stylesheet" href="${href.replace(/"/g, '&quot;')}">`)
    }
    batch.forEach((b, i) => b.resolve(html[i] ?? ''))
  } catch (err) {
    for (const b of batch) {
      cache.delete(b.text)
      b.reject(err)
    }
  }
}

export function markdown(text: string): Promise<string> {
  let got = cache.get(text)
  if (!got) {
    got = new Promise((resolve, reject) => {
      if (!queue.length) queueMicrotask(flush)
      queue.push({ text, resolve, reject })
    })
    cache.set(text, got)
  }
  return got
}
