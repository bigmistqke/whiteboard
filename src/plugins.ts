// Plugins' routes and commands: declared, so the core mounts them under the plugin's name,
// checks the token and the arguments before a plugin's code runs, and lists them in the help
// and the docs. Two plugins can't collide: everything a plugin declares lives under its name,
// and names are unique (and can't be a built-in command).
//
//   routes:   { 'GET /status': { description, auth, query, run } }   → GET /api/<plugin>/status
//   commands: { '': { description, args, options, run }, stop: {…} } → whiteboard <plugin> [stop]
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Command, FieldType, Plugin, Route } from './define.ts'

/** A route as mounted: its method and full path, and the plugin it is from. */
export interface MountedRoute {
  method: string
  path: string
  route: Route
  plugin: string
}

/** A plugin's command as the command line offers it: `whiteboard <plugin> [sub]`. */
export interface PluginCommand {
  plugin: string
  sub: string
  command: Command
  /** `<plugin> <sub>`, as typed */
  name: string
}

// ---- fields --------------------------------------------------------------------------------------
// The small vocabulary of a route's body and query and a command's options: a type name, `?` for
// optional.

type BaseType = 'string' | 'number' | 'boolean' | 'string[]'

const TYPES: Record<BaseType, (v: unknown) => boolean> = {
  string: v => typeof v === 'string',
  number: v => typeof v === 'number' && Number.isFinite(v),
  boolean: v => typeof v === 'boolean',
  'string[]': v => Array.isArray(v) && v.every(x => typeof x === 'string'),
}

function parseType(spec: FieldType | string, where: string): { type: BaseType; optional: boolean } {
  const optional = spec.endsWith('?')
  const type = optional ? spec.slice(0, -1) : spec
  if (!(type in TYPES))
    throw new Error(`${where}: unknown type "${spec}" (one of ${Object.keys(TYPES).join(', ')}, with ? when optional)`)
  return { type: type as BaseType, optional }
}

/** What is wrong with `value` against `spec` ({ name: 'string?' }), or null. Unknown fields are wrong too. */
function checkFields(spec: Record<string, FieldType> = {}, input: unknown = {}, where: string): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return `${where} must be an object`
  const value = input as Record<string, unknown>
  for (const [name, s] of Object.entries(spec)) {
    const { type, optional } = parseType(s, where)
    if (value[name] === undefined) {
      if (!optional) return `${where}: ${name} is missing`
      continue
    }
    if (!TYPES[type](value[name])) return `${where}: ${name} must be ${type}`
  }
  for (const name of Object.keys(value)) if (!(name in spec)) return `${where}: unknown field ${name}`
  return null
}

/** Query strings are text: a number or boolean in the spec is read from it. */
function fromQuery(spec: Record<string, FieldType> = {}, params: URLSearchParams): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, value] of params) {
    const field = spec[name]
    const type = field ? parseType(field, 'query').type : 'string'
    out[name] = type === 'number' ? Number(value) : type === 'boolean' ? value === 'true' || value === '' : value
  }
  return out
}

// ---- routes ------------------------------------------------------------------------------------

const ROUTE = /^(GET|POST|PUT|PATCH|DELETE) (\/[\w\-/]*)$/

/** A plugin's routes, checked and mounted under /api/<name>/. Throws on a malformed one. */
export function mountRoutes(name: string, routes: Record<string, Route> = {}): MountedRoute[] {
  const table: MountedRoute[] = []
  for (const [key, route] of Object.entries(routes)) {
    const m = ROUTE.exec(key)
    if (!m) throw new Error(`plugin ${name}: route "${key}" must look like "GET /path"`)
    if (typeof route?.run !== 'function') throw new Error(`plugin ${name}: route "${key}" has no run function`)
    for (const [field, spec] of Object.entries({ ...route.body, ...route.query }))
      parseType(spec, `plugin ${name}, route "${key}", ${field}`)
    const [, method, at] = m as unknown as [string, string, string]
    const path = `/api/${name}${at === '/' ? '' : at.replace(/\/$/, '')}`
    if (table.some(r => r.method === method && r.path === path))
      throw new Error(`plugin ${name}: route "${key}" is declared twice`)
    table.push({ method, path, route, plugin: name })
  }
  return table
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (c: Buffer) => {
      body += c
      if (body.length > 1e6) {
        reject(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch {
        reject(new Error('the body is not JSON'))
      }
    })
    req.on('error', reject)
  })
}

const json = (res: ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(data))
}

/**
 * Answer a request with the route it matches: false when none does. The core checks the token
 * (`auth`), the query and the body before the route's code runs. A route returns what is sent as
 * JSON; a stream route (`stream: true`) writes to `res` itself. An error it throws is sent with its
 * `status` (default 500).
 */
export async function dispatch(
  table: MountedRoute[],
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  authorized: (req: IncomingMessage) => boolean,
): Promise<boolean> {
  const forPath = table.filter(r => r.path === url.pathname)
  if (!forPath.length) return false
  const hit = forPath.find(r => r.method === req.method)
  if (!hit) {
    res.setHeader('allow', forPath.map(r => r.method).join(', '))
    json(res, 405, { error: `use ${forPath.map(r => r.method).join(' or ')}` })
    return true
  }
  const { route } = hit
  if (route.auth && !authorized(req)) {
    json(res, 403, {
      error: "this needs the project's token: open a link from the command line, or send x-whiteboard-token",
    })
    return true
  }
  try {
    const query = fromQuery(route.query, url.searchParams)
    const queryError = route.query ? checkFields(route.query, query, 'query') : null
    if (queryError) {
      json(res, 400, { error: queryError })
      return true
    }
    let body: Record<string, unknown> = {}
    if (hit.method !== 'GET' && hit.method !== 'DELETE') {
      const input = await readJson(req)
      const bodyError = checkFields(route.body, input, 'body')
      if (bodyError) {
        json(res, 400, { error: bodyError })
        return true
      }
      body = input as Record<string, unknown>
    }
    if (route.stream) {
      await route.run({ body, query, req, res })
      return true
    }
    const out = await route.run({ body, query, req })
    json(res, 200, out ?? { ok: true })
  } catch (err) {
    if (res.headersSent) {
      res.end()
      return true
    }
    const e = err as { status?: number; message?: string } | null
    json(res, e?.status ?? 500, { error: e?.message ?? String(err) })
  }
  return true
}

/** The routes for the docs: method, path, what it does, what it takes. */
export const describeRoutes = (table: MountedRoute[]) =>
  table.map(({ method, path, route }) => ({
    method,
    path,
    description: route.description ?? '',
    auth: !!route.auth,
    stream: !!route.stream,
    body: route.body ?? null,
    query: route.query ?? null,
  }))

// ---- commands ----------------------------------------------------------------------------------

/** The commands of a plugin as `whiteboard <name> [sub]`, checked. */
export function pluginCommands(plugin: Plugin): PluginCommand[] {
  return Object.entries(plugin.commands ?? {}).map(([sub, command]) => {
    const where = `plugin ${plugin.name}, command "${sub}"`
    if (sub && !/^[\w-]+$/.test(sub)) throw new Error(`${where}: use letters, digits, - and _`)
    if (typeof command?.run !== 'function') throw new Error(`${where} has no run function`)
    for (const [name, o] of Object.entries(command.options ?? {})) parseType(o.type, `${where}, option ${name}`)
    return { plugin: plugin.name, sub, command, name: [plugin.name, sub].filter(Boolean).join(' ') }
  })
}

/** `[page] [--restart] [-- <arguments>]` */
export function usage(command: Command): string {
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
export function parseCommandArgs(command: Command, all: string[], name: string) {
  const cut = all.indexOf('--')
  const args = cut < 0 ? all : all.slice(0, cut)
  const rest = cut < 0 ? [] : all.slice(cut + 1)
  if (rest.length && !command.rest)
    throw new Error(`whiteboard ${name} takes nothing after --\nusage: whiteboard ${name} ${usage(command)}`)
  const options: ParseArgsOptionsConfig = Object.fromEntries(
    Object.entries(command.options ?? {}).map(([key, o]) => {
      const { type } = parseType(o.type, key)
      return [
        key,
        {
          type: type === 'boolean' ? ('boolean' as const) : ('string' as const),
          ...(o.short ? { short: o.short } : {}),
        },
      ]
    }),
  )
  let parsed
  try {
    parsed = parseArgs({ args, options, allowPositionals: true, strict: true })
  } catch (err) {
    throw new Error(`${(err as Error).message}\nusage: whiteboard ${name} ${usage(command)}`)
  }
  const values: Record<string, unknown> = { ...parsed.values }
  for (const [key, o] of Object.entries(command.options ?? {})) {
    const { type, optional } = parseType(o.type, key)
    if (values[key] === undefined) {
      if (!optional && type !== 'boolean')
        throw new Error(`--${key} is missing\nusage: whiteboard ${name} ${usage(command)}`)
      continue
    }
    if (type === 'number') {
      values[key] = Number(values[key])
      if (!Number.isFinite(values[key])) throw new Error(`--${key} must be a number`)
    }
  }
  return { options: values, positionals: parsed.positionals, rest }
}
