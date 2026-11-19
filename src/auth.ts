// The project's token: what a browser or command needs for anything that runs code, such as an
// plugin that starts a process. Pages and events don't need it.
//
//   /_/auth?token=…&to=/page   sets the token as a cookie in this browser, then goes to `to`
//
// The token is made on first use and kept in `.whiteboard/token`, readable by its owner only. The
// command line sends it as a header; a browser gets it once through the link above (a command
// prints it). The cookie is HttpOnly and SameSite=Lax, and a request from another site is refused
// even with it, so a website open in the same browser can't use it. One kind is let through: opening
// a page as the tab's document, as a link from another app or a reload of such a tab does. Then the
// page shows what needs the token (the terminal drawer) to the reader alone: the site that sent them
// there can't read it, and the page's own requests come from its own origin.
//
// The cookie is Lax, not Strict, for that same case: a browser sends no Strict cookie on a
// navigation from outside, and a reload of that tab doesn't either, so such a tab never had the
// drawer until a link inside the page was followed.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

const COOKIE = 'wb-token'

/** The project's token, made on first use. */
export function projectToken(wb: string): string {
  const file = path.join(wb, 'token')
  try {
    return fs.readFileSync(file, 'utf8').trim()
  } catch {}
  const token = crypto.randomBytes(24).toString('base64url')
  fs.writeFileSync(file, token + '\n', { mode: 0o600 })
  return token
}

/** `base`: the path the project is served under (see ServerOptions), which its cookie is kept to. */
export function createAuth(wb: string, base = '') {
  const token = projectToken(wb)
  const same = (a: unknown, b: string): boolean =>
    typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
  const cookies = (req: IncomingMessage): Record<string, string | undefined> =>
    Object.fromEntries(
      (req.headers.cookie ?? '')
        .split(';')
        .map(c => c.trim().split('='))
        .filter(([k]) => k),
    )

  /** Has this request the token, from this origin? No request (a page being built) has none. */
  function authorized(req: IncomingMessage | null): boolean {
    if (!req) return false
    const jar = cookies(req)
    const has = same(jar[COOKIE], token) || same(req.headers['x-whiteboard-token'], token)
    if (!has) return false
    const origin = req.headers.origin
    if (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return false
    const site = req.headers['sec-fetch-site']
    if (site && site !== 'same-origin' && site !== 'none' && !opensPage(req)) return false
    return true
  }

  /** Opening a page as the tab's document: no frame, no fetch, and not an API route. */
  const opensPage = (req: IncomingMessage) =>
    req.method === 'GET' &&
    req.headers['sec-fetch-mode'] === 'navigate' &&
    req.headers['sec-fetch-dest'] === 'document' &&
    !(req.url ?? '').startsWith('/api/')

  /** The /_/auth route; false for any other path. */
  function handle(req: IncomingMessage, res: ServerResponse, p: string, q: Record<string, unknown>): boolean {
    if (p !== '/_/auth') return false
    if (!same(q.token, token)) {
      res.writeHead(403, { 'content-type': 'text/plain' })
      res.end('wrong token')
      return true
    }
    const to = typeof q.to === 'string' && q.to.startsWith('/') && !q.to.startsWith('//') ? q.to : '/'
    res.writeHead(302, {
      // under a shared server, each project's token is sent only to its own path
      'set-cookie': `${COOKIE}=${token}; Path=${base || '/'}; HttpOnly; SameSite=Lax; Max-Age=31536000`,
      location: base + to,
    })
    res.end()
    return true
  }

  return { authorized, handle, token }
}
