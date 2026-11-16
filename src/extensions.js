// Extensions' routes and commands: declared, so the core mounts them under the extension's name,
// checks the token and the arguments before an extension's code runs, and lists them in the help
// and the docs. Two extensions can't collide: everything an extension declares lives under its name,
// and names are unique (and can't be a built-in command).
//
//   routes:   { 'GET /status': { description, auth, query, run } }   → GET /api/<extension>/status
//   commands: { '': { description, args, options, run }, stop: {…} } → whiteboard <extension> [stop]
import { parseArgs } from 'node:util'

// ---- fields --------------------------------------------------------------------------------------
// The small vocabulary of a route's body and query and a command's options: a type name, `?` for
// optional.

const TYPES = {
  string: v => typeof v === 'string',
  number: v => typeof v === 'number' && Number.isFinite(v),
  boolean: v => typeof v === 'boolean',
  'string[]': v => Array.isArray(v) && v.every(x => typeof x === 'string'),
}

function parseType(spec, where) {
  const optional = spec.endsWith('?')
  const type = optional ? spec.slice(0, -1) : spec
  if (!(type in TYPES)) throw new Error(`${where}: unknown type "${spec}" (one of ${Object.keys(TYPES).join(', ')}, with ? when optional)`)
  return { type, optional }
}

/** What is wrong with `value` against `spec` ({ name: 'string?' }), or null. Unknown fields are wrong too. */
function checkFields(spec = {}, value = {}, where) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${where} must be an object`
  for (const [name, s] of Object.entries(spec)) {
    const { type, optional } = parseType(s, where)
    if (value[name] === undefined) { if (!optional) return `${where}: ${name} is missing`; continue }
    if (!TYPES[type](value[name])) return `${where}: ${name} must be ${type}`
  }
  for (const name of Object.keys(value)) if (!(name in spec)) return `${where}: unknown field ${name}`
  return null
}

/** Query strings are text: a number or boolean in the spec is read from it. */
function fromQuery(spec = {}, params) {
  const out = {}
  for (const [name, value] of params) {
    const type = spec[name] ? parseType(spec[name], 'query').type : 'string'
    out[name] = type === 'number' ? Number(value) : type === 'boolean' ? value === 'true' || value === '' : value
  }
  return out
}

// ---- routes ------------------------------------------------------------------------------------

const ROUTE = /^(GET|POST|PUT|PATCH|DELETE) (\/[\w\-/]*)$/

/** An extension's routes, checked and mounted under /api/<name>/. Throws on a malformed one. */
export function mountRoutes(name, routes = {}) {
  const table = []
  for (const [key, route] of Object.entries(routes)) {
    const m = ROUTE.exec(key)
    if (!m) throw new Error(`extension ${name}: route "${key}" must look like "GET /path"`)
    if (typeof route?.run !== 'function') throw new Error(`extension ${name}: route "${key}" has no run function`)
    for (const [field, spec] of Object.entries({ ...route.body, ...route.query })) parseType(spec, `extension ${name}, route "${key}", ${field}`)
    const path = `/api/${name}${m[2] === '/' ? '' : m[2].replace(/\/$/, '')}`
    if (table.some(r => r.method === m[1] && r.path === path)) throw new Error(`extension ${name}: route "${key}" is declared twice`)
    table.push({ method: m[1], path, route, extension: name })
  }
  return table
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', c => { body += c; if (body.length > 1e6) { reject(new Error('body too large')); req.destroy() } })
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}) } catch { reject(new Error('the body is not JSON')) } })
    req.on('error', reject)
  })
}

const json = (res, status, data) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(data))
}

/**
 * Answer a request with the route it matches: false when none does. The core checks the token
 * (`auth`), the query and the body before the route's code runs. A route returns what is sent as
 * JSON; a stream route (`stream: true`) writes to `res` itself. An error it throws is sent with its
 * `status` (default 500).
 */
export async function dispatch(table, req, res, url, authorized) {
  const forPath = table.filter(r => r.path === url.pathname)
  if (!forPath.length) return false
  const hit = forPath.find(r => r.method === req.method)
  if (!hit) { res.setHeader('allow', forPath.map(r => r.method).join(', ')); json(res, 405, { error: `use ${forPath.map(r => r.method).join(' or ')}` }); return true }
  const { route } = hit
  if (route.auth && !authorized(req)) { json(res, 403, { error: 'this needs the project\'s token: open a link from the command line, or send x-whiteboard-token' }); return true }
  try {
    const query = fromQuery(route.query, url.searchParams)
    const queryError = route.query ? checkFields(route.query, query, 'query') : null
    if (queryError) { json(res, 400, { error: queryError }); return true }
    let body = {}
    if (hit.method !== 'GET' && hit.method !== 'DELETE') {
      body = await readJson(req)
      const bodyError = checkFields(route.body, body, 'body')
      if (bodyError) { json(res, 400, { error: bodyError }); return true }
    }
    if (route.stream) { await route.run({ body, query, req, res }); return true }
    const out = await route.run({ body, query, req })
    json(res, 200, out ?? { ok: true })
  } catch (err) {
    if (res.headersSent) { res.end(); return true }
    json(res, err?.status ?? 500, { error: err?.message ?? String(err) })
  }
  return true
}

/** The routes for the docs: method, path, what it does, what it takes. */
export const describeRoutes = table => table.map(({ method, path, route }) => ({
  method, path, description: route.description ?? '', auth: !!route.auth, stream: !!route.stream,
  body: route.body ?? null, query: route.query ?? null,
}))

// ---- commands ----------------------------------------------------------------------------------

/** The commands of an extension as `whiteboard <name> [sub]`, checked. */
export function extensionCommands(extension) {
  return Object.entries(extension.commands ?? {}).map(([sub, command]) => {
    const where = `extension ${extension.name}, command "${sub}"`
    if (sub && !/^[\w-]+$/.test(sub)) throw new Error(`${where}: use letters, digits, - and _`)
    if (typeof command?.run !== 'function') throw new Error(`${where} has no run function`)
    for (const [name, o] of Object.entries(command.options ?? {})) parseType(o.type, `${where}, option ${name}`)
    return { extension: extension.name, sub, command, name: [extension.name, sub].filter(Boolean).join(' ') }
  })
}

/** `[page] [--restart] [-- <arguments>]` */
export function usage(command) {
  const options = Object.entries(command.options ?? {}).map(([name, o]) => {
    const { type } = parseType(o.type, name)
    return `[--${name}${type === 'boolean' ? '' : ` <${o.value ?? type}>`}]`
  })
  return [command.args ?? '', ...options, command.rest ? `[-- ${command.rest}]` : ''].filter(Boolean).join(' ')
}

/**
 * Parse a command's arguments by its declared options; throws with the usage on a wrong one. What
 * follows `--` is passed on untouched, as `rest`, when the command takes it.
 */
export function parseCommandArgs(command, all, name) {
  const cut = all.indexOf('--')
  const args = cut < 0 ? all : all.slice(0, cut)
  const rest = cut < 0 ? [] : all.slice(cut + 1)
  if (rest.length && !command.rest) throw new Error(`whiteboard ${name} takes nothing after --\nusage: whiteboard ${name} ${usage(command)}`)
  const options = Object.fromEntries(Object.entries(command.options ?? {}).map(([key, o]) => {
    const { type } = parseType(o.type, key)
    return [key, { type: type === 'boolean' ? 'boolean' : 'string', ...(o.short ? { short: o.short } : {}) }]
  }))
  let parsed
  try { parsed = parseArgs({ args, options, allowPositionals: true, strict: true }) } catch (err) {
    throw new Error(`${err.message}\nusage: whiteboard ${name} ${usage(command)}`)
  }
  const values = { ...parsed.values }
  for (const [key, o] of Object.entries(command.options ?? {})) {
    const { type, optional } = parseType(o.type, key)
    if (values[key] === undefined) { if (!optional && type !== 'boolean') throw new Error(`--${key} is missing\nusage: whiteboard ${name} ${usage(command)}`); continue }
    if (type === 'number') {
      values[key] = Number(values[key])
      if (!Number.isFinite(values[key])) throw new Error(`--${key} must be a number`)
    }
  }
  return { options: values, positionals: parsed.positionals, rest }
}
