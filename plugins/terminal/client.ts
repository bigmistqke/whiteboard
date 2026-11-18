// The terminal drawer at the bottom of every page (for a browser with the project's token; see
// server.ts). The server writes its markup and sets its open state before the first render, so
// the browser can morph it from the page before (a view transition across the page load). This module
// connects it: an xterm that shows the session of the current tab, keystrokes and size sent back,
// and a tab per session, with "+" for a shell next to them.
//
// The sessions live on the server. Each page load connects again and first gets the whole screen of
// its tab, so switching pages loses nothing.
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

const store = {
  get: (k: string) => {
    try {
      return sessionStorage.getItem(k)
    } catch {
      return null
    }
  },
  set: (k: string, v: string) => {
    try {
      sessionStorage.setItem(k, v)
    } catch {
      /* storage unavailable */
    }
  },
}

interface Session {
  id: string
  label: string
  running: boolean
  exited: number | null
}

function init(drawer: HTMLElement) {
  const screen = drawer.querySelector<HTMLElement>('.wb-term-screen')!
  const tabs = drawer.querySelector<HTMLElement>('.wb-term-tabs')!
  const status = drawer.querySelector<HTMLElement>('.wb-term-status')!
  const actions = drawer.querySelector<HTMLElement>('.wb-term-actions')!
  const toggle = drawer.querySelector<HTMLButtonElement>('.wb-term-toggle')!
  const grip = drawer.querySelector<HTMLElement>('.wb-term-grip')!
  // the sessions as the server wrote them into the page, and the tab this browser tab shows
  let sessions: Session[] = []
  try {
    ;({ sessions } = JSON.parse(drawer.dataset.sessions ?? '{}'))
    sessions ??= []
  } catch {
    /* none */
  }
  let current: string | null = drawer.dataset.tab ?? sessions[0]?.id ?? null

  const term = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    // xterm scales every wheel event smaller than 50 pixels down to 0.3 of its lines, and a trackpad
    // sends almost only those: a swipe moved a program that handles the mouse itself (scrolling its
    // own view) at a third of the speed of a native terminal. This undoes that factor.
    scrollSensitivity: 3,
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
  // A session has one size for every drawer showing it (every browser window): the size of the
  // drawer the reader used last, its active viewer (see host.ts). This drawer reports the size that
  // fits it, claims the session when the reader uses it (opening it, focus, a keystroke), and
  // otherwise shows the session at the session's size: with a margin, or cut off at the right.
  const viewer = crypto.randomUUID()
  // the session's active viewer and size, as the host last said
  let active: string | null = null
  let session: { cols: number; rows: number } | null = null
  // this browser tab was the one in use: its next page claims the session again
  let claim = store.get('wb-terminal-active') === '1'
  let sent = ''
  const mine = () => active === viewer

  /** Tell the host the size that fits this drawer, and whether the reader uses it now. */
  function refit() {
    if (!isOpen() || !current) return
    const dims = fit.proposeDimensions()
    if (!dims?.cols || !dims?.rows) return
    const key = `${current} ${dims.cols}x${dims.rows} ${claim}`
    if (key !== sent) {
      sent = key
      post('/api/terminal/resize', { id: current, viewer, cols: dims.cols, rows: dims.rows, active: claim })
      // it is ours from now on; the host confirms with a `size`
      if (claim) {
        active = viewer
        claim = false
      }
    }
    show()
  }

  /** The terminal at the size it has here: its own when this drawer is the active one, else the session's. */
  function show() {
    const dims = fit.proposeDimensions()
    const size = mine() || !session ? dims : session
    if (size?.cols && size?.rows && (size.cols !== term.cols || size.rows !== term.rows))
      term.resize(size.cols, size.rows)
  }

  /** The reader uses this drawer: the session takes its size. */
  function use() {
    if (mine() || !current) return
    claim = true
    refit()
  }

  new ResizeObserver(() => refit()).observe(screen)
  term.textarea?.addEventListener('focus', use)

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
    requestAnimationFrame(() => {
      if (open) use()
      refit()
      if (open) term.focus()
    })
  }
  toggle.addEventListener('click', () => setOpen(!isOpen()))
  addEventListener('keydown', e => {
    if (e.ctrlKey && e.key === '`') {
      e.preventDefault()
      setOpen(!isOpen())
    }
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
    if (!current) return
    use()
    const id = current
    if (!pending)
      queueMicrotask(() => {
        const data = pending
        pending = ''
        chain = chain
          .then(() => post('/api/terminal/input', { id, data }))
          .then(
            () => {},
            () => {},
          )
      })
    pending += d
  })

  // ---- the session ---------------------------------------------------------------------------
  function setStatus(text: string, buttons: [string, () => void][] = []) {
    status.textContent = text
    actions.replaceChildren(
      ...buttons.map(([label, run]) => {
        const b = document.createElement('button')
        b.type = 'button'
        b.textContent = label
        b.addEventListener('click', run)
        return b
      }),
    )
  }

  // ---- tabs ----------------------------------------------------------------------------------
  function drawTabs() {
    tabs.replaceChildren(
      ...sessions.map(x => {
        const tab = document.createElement('span')
        tab.className = 'wb-term-tab'
        tab.dataset.id = x.id
        tab.classList.toggle('wb-current', x.id === current)
        tab.toggleAttribute('data-exited', !x.running)
        const name = document.createElement('button')
        name.type = 'button'
        name.className = 'wb-term-tab-name'
        name.textContent = x.label
        name.title = x.running ? x.label : `${x.label}: exited (${x.exited})`
        name.addEventListener('click', () => select(x.id))
        tab.append(name)
        const close = document.createElement('button')
        close.type = 'button'
        close.className = 'wb-term-tab-close'
        close.title = 'Close this tab (ends its program)'
        close.textContent = '×'
        close.addEventListener('click', () => closeTab(x.id))
        tab.append(close)
        return tab
      }),
    )
    showStatus()
  }

  // "+" at the bar's right end, after the tabs, outside them so it stays in view when they scroll
  const add = document.createElement('button')
  add.type = 'button'
  add.className = 'wb-term-add'
  add.title = 'A new tab with a shell'
  add.textContent = '+'
  add.addEventListener('click', () => start({}))
  tabs.after(add)

  function showStatus() {
    const x = sessions.find(y => y.id === current)
    // no tab yet: "+" opens one
    if (!x) return setStatus('', [])
    if (x.running) return setStatus('', [])
    setStatus(x.exited == null ? 'stopped' : `exited (${x.exited})`, [
      ['Start again', () => start({ id: x.id, restart: true })],
    ])
  }

  function select(id: string | null) {
    // the tab that shows already: just give it the keyboard back
    if (id === current && stream) {
      if (isOpen()) term.focus()
      return
    }
    current = id
    if (id) store.set('wb-terminal-tab', id)
    drawTabs()
    connect()
    if (isOpen()) term.focus()
  }

  async function closeTab(id: string) {
    await post('/api/terminal/close', { id })
    sessions = sessions.filter(x => x.id !== id)
    if (current === id) select(sessions.at(-1)?.id ?? null)
    else drawTabs()
  }

  /** Open a tab with the shell, or start tab `id` again as it was. */
  async function start(body: { id?: string; restart?: boolean }) {
    setStatus('starting…')
    const res = await post('/api/terminal/start', body)
    const reply = await res.json().catch(() => ({}))
    if (!res.ok) return setStatus(reply.error ?? 'could not start', [['Try again', () => start(body)]])
    await loadSessions()
    if (!isOpen()) setOpen(true)
    select(reply.session)
    term.focus()
  }

  async function loadSessions() {
    try {
      const res = await fetch('/api/terminal/sessions')
      if (res.ok) ({ sessions } = await res.json())
    } catch {
      /* the server is away: the stream reconnects */
    }
    drawTabs()
  }

  let stream: EventSource | null = null
  function connect() {
    stream?.close()
    term.reset()
    sent = ''
    if (!current) showStatus()
    // without a tab too: the host tells it when one appears (started from the command line, say)
    stream = new EventSource(
      `/api/terminal/stream?${current ? `id=${encodeURIComponent(current)}&` : ''}viewer=${viewer}`,
    )
    stream.addEventListener('sessions', e => {
      sessions = JSON.parse((e as MessageEvent).data).sessions
      // the current tab is gone, or there was none and one appeared: show the last
      if (current ? !sessions.some(x => x.id === current) : sessions.length) return select(sessions.at(-1)?.id ?? null)
      drawTabs()
    })
    stream.addEventListener('none', () => {
      term.reset()
      screen.querySelectorAll('.wb-term-placeholder').forEach(p => p.remove())
      showStatus()
    })
    stream.addEventListener('screen', e => {
      const { d, cols, rows, active: a } = JSON.parse((e as MessageEvent).data)
      term.reset()
      // the screen as the host has it, at the session's size; then the size this drawer shows it at
      session = cols && rows ? { cols, rows } : null
      active = a ?? null
      if (session) term.resize(session.cols, session.rows)
      term.write(d, () => {
        refit()
        // the live terminal takes over from the screens the server wrote into the page
        screen.querySelectorAll('.wb-term-placeholder').forEach(p => p.remove())
      })
      showStatus()
      if (isOpen() && store.get('wb-terminal-focus') === '1') term.focus()
    })
    stream.addEventListener('data', e => term.write(JSON.parse((e as MessageEvent).data).d))
    // a program in this tab asked to show a page here (`whiteboard terminal open`): the drawer comes along
    stream.addEventListener('navigate', e => {
      const { path } = JSON.parse((e as MessageEvent).data)
      if (typeof path === 'string' && path.startsWith('/') && !path.startsWith('//')) location.assign(path)
    })
    // the session's size changed, or another drawer became the active one
    stream.addEventListener('size', e => {
      const { cols, rows, active: a } = JSON.parse((e as MessageEvent).data)
      session = { cols, rows }
      active = a ?? null
      store.set('wb-terminal-active', mine() ? '1' : '0')
      show()
    })
    stream.addEventListener('exit', e => {
      const code = JSON.parse((e as MessageEvent).data).code
      const x = sessions.find(y => y.id === current)
      if (x) {
        x.running = false
        x.exited = code
      }
      drawTabs()
    })
  }

  // whether the terminal had the keyboard, for the next page
  addEventListener('pagehide', () =>
    store.set('wb-terminal-focus', drawer.contains(document.activeElement) ? '1' : '0'),
  )

  drawTabs()
  connect()
}

function post(url: string, body: unknown) {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

const drawer = document.getElementById('wb-terminal')
if (drawer) init(drawer)
