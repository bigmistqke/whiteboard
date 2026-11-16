// The terminal drawer at the bottom of every page (for a browser with the project's token; see
// server.js). The server writes its markup and sets its open state before the first render, so
// the browser can morph it from the page before (a view transition across the page load). This module
// connects it: an xterm that shows the session the server runs, keystrokes and size sent back.
//
// The session lives on the server. Each page load connects again and first gets the whole screen, so
// switching pages loses nothing.
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

const store = {
  get: (k: string) => { try { return sessionStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string) => { try { sessionStorage.setItem(k, v) } catch { /* storage unavailable */ } },
}

function init(drawer: HTMLElement) {
  const screen = drawer.querySelector<HTMLElement>('.wb-term-screen')!
  const status = drawer.querySelector<HTMLElement>('.wb-term-status')!
  const actions = drawer.querySelector<HTMLElement>('.wb-term-actions')!
  const toggle = drawer.querySelector<HTMLButtonElement>('.wb-term-toggle')!
  const grip = drawer.querySelector<HTMLElement>('.wb-term-grip')!
  // the program the session runs, by name, as the extension's config says
  const label = drawer.dataset.command || 'terminal'

  const term = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    theme: { background: '#0f1115', foreground: '#d7dae0', cursor: '#d7dae0', selectionBackground: '#3a4150' },
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(screen)

  const isOpen = () => drawer.dataset.state === 'open'
  // drop the ?terminal=open the auth link adds, now that the state is in this tab
  if (new URLSearchParams(location.search).get('terminal') === 'open') {
    store.set('wb-terminal-open', '1')
    const url = new URL(location.href)
    url.searchParams.delete('terminal')
    history.replaceState(history.state, '', url)
  }

  // ---- size ----------------------------------------------------------------------------------
  let sent = ''
  function refit() {
    if (!isOpen()) return
    try { fit.fit() } catch { return }
    const size = `${term.cols}x${term.rows}`
    if (size === sent) return
    sent = size
    post('/api/terminal/resize', { cols: term.cols, rows: term.rows })
  }
  new ResizeObserver(() => refit()).observe(screen)

  // ---- open and closed -----------------------------------------------------------------------
  function setOpen(open: boolean) {
    const apply = () => {
      drawer.dataset.state = open ? 'open' : 'collapsed'
      store.set('wb-terminal-open', open ? '1' : '0')
    }
    // the drawer morphs between its two states, as between pages
    const vt = (document as any).startViewTransition
    if (vt && !matchMedia('(prefers-reduced-motion: reduce)').matches) vt.call(document, apply)
    else apply()
    requestAnimationFrame(() => { refit(); if (open) term.focus() })
  }
  toggle.addEventListener('click', () => setOpen(!isOpen()))
  addEventListener('keydown', e => {
    if (e.ctrlKey && e.key === '`') { e.preventDefault(); setOpen(!isOpen()) }
  })

  // ---- height --------------------------------------------------------------------------------
  grip.addEventListener('pointerdown', e => {
    e.preventDefault()
    grip.setPointerCapture(e.pointerId)
    if (!isOpen()) setOpen(true)
    const bar = drawer.querySelector<HTMLElement>('.wb-term-bar')!.offsetHeight
    const move = (ev: PointerEvent) => {
      const h = Math.max(120, Math.min(innerHeight - 80, innerHeight - ev.clientY - bar))
      document.documentElement.style.setProperty('--wb-term-h', `${Math.round(h)}px`)
    }
    const up = () => {
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', up)
      const h = getComputedStyle(document.documentElement).getPropertyValue('--wb-term-h')
      store.set('wb-terminal-height', String(parseInt(h) || ''))
      refit()
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', up)
  })

  // ---- input ---------------------------------------------------------------------------------
  // keystrokes in order, several typed at once in one request
  let pending = ''
  let chain = Promise.resolve()
  term.onData(d => {
    if (!pending) queueMicrotask(() => {
      const data = pending
      pending = ''
      chain = chain.then(() => post('/api/terminal/input', { data })).then(() => {}, () => {})
    })
    pending += d
  })

  // ---- the session ---------------------------------------------------------------------------
  function setStatus(text: string, buttons: [string, () => void][] = []) {
    status.textContent = text
    actions.replaceChildren(...buttons.map(([label, run]) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = label
      b.addEventListener('click', run)
      return b
    }))
  }

  async function start(restart = false) {
    setStatus('starting…')
    const res = await post('/api/terminal/start', { args: [], restart })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) return setStatus(body.error ?? 'could not start', [['Try again', () => start(restart)]])
    connect()
    if (!isOpen()) setOpen(true)
    else term.focus()
  }

  let stream: EventSource | null = null
  function connect() {
    stream?.close()
    stream = new EventSource('/api/terminal/stream')
    stream.addEventListener('none', () => {
      term.reset()
      screen.querySelector('.wb-term-placeholder')?.remove()
      setStatus('no session', [[`Start ${label}`, () => start()]])
    })
    stream.addEventListener('screen', e => {
      const { d, cols, rows, exited } = JSON.parse((e as MessageEvent).data)
      term.reset()
      // the screen as the server has it, at its size; then this tab's own size, if it differs
      if (cols && rows) term.resize(cols, rows)
      sent = `${cols}x${rows}`
      term.write(d, () => {
        refit()
        // the live terminal takes over from the screen the server wrote into the page
        screen.querySelector('.wb-term-placeholder')?.remove()
      })
      if (exited != null) exitedStatus(exited)
      else setStatus(label, [['Restart', () => start(true)]])
      if (isOpen() && store.get('wb-terminal-focus') === '1') term.focus()
    })
    stream.addEventListener('data', e => term.write(JSON.parse((e as MessageEvent).data).d))
    stream.addEventListener('exit', e => exitedStatus(JSON.parse((e as MessageEvent).data).code))
  }
  const exitedStatus = (code: number | null) => setStatus(code == null ? 'stopped' : `exited (${code})`, [[`Start ${label}`, () => start(true)]])

  // whether the terminal had the keyboard, for the next page
  addEventListener('pagehide', () => store.set('wb-terminal-focus', drawer.contains(document.activeElement) ? '1' : '0'))

  connect()
}

function post(url: string, body: unknown) {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

const drawer = document.getElementById('wb-terminal')
if (drawer) init(drawer)
