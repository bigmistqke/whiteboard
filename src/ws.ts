// A WebSocket that only the server talks on: the page's live channel (/api/live). Not a server-sent
// event stream because a browser keeps at most six HTTP/1.1 connections to one origin, and every
// whiteboard tab is on the same one (the shared server): six open tabs, each holding its stream,
// left no connection for a seventh tab to load, nor for a form's answer to be sent. WebSockets don't
// count towards that limit.
//
// Enough of RFC 6455 for that: the handshake, text frames out, and of what comes in, close and ping
// (answered); anything else from the browser is read and dropped. A ping goes out every 25 s, so a
// connection that went away without closing is found and let go.
import crypto from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const PING_EVERY = 25_000

export interface Socket {
  /** send one text message; nothing once closed */
  send(text: string): void
  /** close it: a close frame, then the connection ends */
  close(): void
  /** called once, when it closed (either side, or the connection broke) */
  onClose(fn: () => void): void
}

/** Is this request asking to become a WebSocket? */
export const isUpgrade = (req: IncomingMessage) =>
  (req.headers.upgrade ?? '').toLowerCase() === 'websocket' && !!req.headers['sec-websocket-key']

/** Answer the handshake and give the socket; null (and the connection refused) if it isn't one. */
export function accept(req: IncomingMessage, conn: Duplex): Socket | null {
  const key = req.headers['sec-websocket-key']
  if (!isUpgrade(req) || typeof key !== 'string' || req.headers['sec-websocket-version'] !== '13') {
    refuse(conn, 400, 'Bad Request')
    return null
  }
  const hash = crypto
    .createHash('sha1')
    .update(key + GUID)
    .digest('base64')
  conn.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${hash}\r\n\r\n`,
  )
  if ('setNoDelay' in conn && typeof conn.setNoDelay === 'function') conn.setNoDelay(true)

  let open = true
  const closers: (() => void)[] = []
  const ended = () => {
    if (!open) return
    open = false
    clearInterval(ping)
    for (const fn of closers.splice(0)) fn()
  }
  const write = (opcode: number, payload: Buffer) => {
    if (!open || conn.destroyed) return
    conn.write(Buffer.concat([header(opcode, payload.length), payload]))
  }
  let alive = true
  const ping = setInterval(() => {
    // no pong since the last ping: it went away without closing
    if (!alive) return void conn.destroy()
    alive = false
    write(0x9, Buffer.alloc(0))
  }, PING_EVERY)
  ping.unref?.()

  let buf = Buffer.alloc(0)
  conn.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk])
    for (;;) {
      const frame = parse(buf)
      if (!frame) break
      buf = buf.subarray(frame.size)
      alive = true
      if (frame.opcode === 0x8) {
        write(0x8, frame.payload.subarray(0, 2))
        ended()
        conn.end()
        return
      }
      if (frame.opcode === 0x9) write(0xa, frame.payload)
      // a browser has nothing to say on this channel: text, binary and pongs are dropped
    }
    // a frame that claims to be huge: not a browser of ours
    if (buf.length > 1 << 20) conn.destroy()
  })
  conn.on('close', ended)
  conn.on('error', () => conn.destroy())

  return {
    send: text => write(0x1, Buffer.from(text, 'utf8')),
    close() {
      if (!open) return
      write(0x8, Buffer.from([0x03, 0xe8])) // 1000: normal closure
      ended()
      conn.end()
      // a peer that never closes its side
      setTimeout(() => conn.destroy(), 1000).unref?.()
    },
    onClose(fn) {
      if (open) closers.push(fn)
      else fn()
    },
  }
}

/** Turn an upgrade down with a plain HTTP response. */
export function refuse(conn: Duplex, status: number, text: string) {
  if (conn.destroyed) return
  conn.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

/** A frame's header, unmasked as the server sends them, FIN set. */
function header(opcode: number, length: number): Buffer {
  if (length < 126) return Buffer.from([0x80 | opcode, length])
  if (length < 1 << 16) {
    const h = Buffer.alloc(4)
    h[0] = 0x80 | opcode
    h[1] = 126
    h.writeUInt16BE(length, 2)
    return h
  }
  const h = Buffer.alloc(10)
  h[0] = 0x80 | opcode
  h[1] = 127
  h.writeBigUInt64BE(BigInt(length), 2)
  return h
}

/** One whole frame at the start of `buf` (unmasked), or null while it hasn't all arrived. */
function parse(buf: Buffer): { opcode: number; payload: Buffer; size: number } | null {
  if (buf.length < 2) return null
  const opcode = buf[0]! & 0x0f
  const masked = (buf[1]! & 0x80) !== 0
  let length = buf[1]! & 0x7f
  let at = 2
  if (length === 126) {
    if (buf.length < 4) return null
    length = buf.readUInt16BE(2)
    at = 4
  } else if (length === 127) {
    if (buf.length < 10) return null
    const big = buf.readBigUInt64BE(2)
    if (big > BigInt(1 << 20)) return { opcode: 0x8, payload: Buffer.alloc(0), size: buf.length }
    length = Number(big)
    at = 10
  }
  const mask = masked ? buf.subarray(at, at + 4) : null
  if (masked) at += 4
  if (buf.length < at + length) return null
  const payload = Buffer.from(buf.subarray(at, at + length))
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!
  return { opcode, payload, size: at + length }
}
