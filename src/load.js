// Loading a project's config with Node itself: Node runs the TypeScript of `config.ts`, and these
// hooks do the two things it cannot do alone.
//
// - `@bigmistqke/whiteboard/*` always means this engine's own build, so a config works in a
//   project without node_modules (a Rust repository, a home folder), and it always matches the
//   server that runs it. Which file a subpath is comes from the package's `exports`, read afresh
//   on every resolve, so a part added to the package works without restarting the server.
// - Reloading. Node evaluates a module once per URL; the config and every local module it imports
//   get a version in their URL, and a new version imports them again. Modules in node_modules are
//   left alone: they don't change while the server runs.
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ENGINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE = '@bigmistqke/whiteboard/'

/** The file `@bigmistqke/whiteboard/<part>` is, by the package's `exports`; null for none. */
function ownFile(specifier) {
  if (!specifier.startsWith(PACKAGE)) return null
  let exports
  try { exports = JSON.parse(fs.readFileSync(path.join(ENGINE_DIR, 'package.json'), 'utf8')).exports } catch { return null }
  const target = exports?.[`./${specifier.slice(PACKAGE.length)}`]
  const file = typeof target === 'string' ? target : target?.default
  return file ? path.join(ENGINE_DIR, file) : null
}

const versionOf = url => new URL(url).searchParams.get('wb-v')

registerHooks({
  resolve(specifier, context, next) {
    const own = ownFile(specifier)
    if (own) {
      const url = pathToFileURL(own).href
      const v = context.parentURL && versionOf(context.parentURL)
      return { url: v ? `${url}?wb-v=${v}` : url, shortCircuit: true, format: 'module' }
    }
    const resolved = next(specifier, context)
    if (!resolved.url.startsWith('file:') || resolved.url.includes('/node_modules/')) return resolved
    const v = versionOf(resolved.url) ?? (context.parentURL?.startsWith('file:') && versionOf(context.parentURL))
    if (!v) return resolved
    const url = new URL(resolved.url)
    url.searchParams.set('wb-v', v)
    // a .whiteboard folder has no package.json of its own to say these are ES modules
    return { ...resolved, url: url.href, format: resolved.format ?? moduleFormat(url.pathname) }
  },
})

function moduleFormat(file) {
  if (/\.[mc]?ts$/.test(file)) return file.endsWith('.cts') ? 'commonjs-typescript' : 'module-typescript'
  if (/\.c?js$/.test(file)) return file.endsWith('.cjs') ? 'commonjs' : 'module'
  return undefined
}

let version = 0

/** Import `file` and everything local it imports afresh. */
export function importFresh(file) {
  return import(`${pathToFileURL(file).href}?wb-v=${++version}`)
}
