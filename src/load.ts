// Loading a project's config with Node itself: Node runs the TypeScript of `config.ts`, and these
// hooks do the two things it cannot do alone.
//
// - `@bigmistqke/whiteboard` and its parts always mean this engine's own files, so a config works in a
//   project without node_modules (a Rust repository, a home folder), and it always matches the
//   server that runs it. Which file a subpath is comes from the package's `exports`, read afresh
//   on every resolve, so a part added to the package works without restarting the server: its
//   `source` (the TypeScript) when the engine runs from source, else its build.
// - Reloading. Node evaluates a module once per URL; the config and every local module it imports
//   get a version in their URL, and a new version imports them again. Modules in node_modules are
//   left alone: they don't change while the server runs.
import fs from 'node:fs'
import { registerHooks, type ModuleFormat } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { FROM_SOURCE, PACKAGE_DIR } from './package.ts'

const ENGINE_DIR = PACKAGE_DIR
const PACKAGE = '@bigmistqke/whiteboard'

/** The file `@bigmistqke/whiteboard` or one of its parts is, by the package's `exports`; null for none. */
function ownFile(specifier: string): string | null {
  if (specifier !== PACKAGE && !specifier.startsWith(PACKAGE + '/')) return null
  let exports: Record<string, string | { source?: string; default?: string }> | undefined
  try { exports = JSON.parse(fs.readFileSync(path.join(ENGINE_DIR, 'package.json'), 'utf8')).exports } catch { return null }
  const target = exports?.[specifier === PACKAGE ? '.' : `./${specifier.slice(PACKAGE.length + 1)}`]
  const file = typeof target === 'string' ? target : (FROM_SOURCE && target?.source) || target?.default
  return file ? path.join(ENGINE_DIR, file) : null
}

const versionOf = (url: string) => new URL(url).searchParams.get('wb-v')

/**
 * Install the hooks, once: the first time something loads a config or the package's own parts, not
 * on import, so a command that loads nothing leaves the process's module loading alone.
 */
let installed = false
export function installHooks() {
  if (installed) return
  installed = true
  registerHooks({
    resolve(specifier, context, next) {
      const own = ownFile(specifier)
      if (own) {
        const url = pathToFileURL(own).href
        const v = context.parentURL && versionOf(context.parentURL)
        return { url: v ? `${url}?wb-v=${v}` : url, shortCircuit: true, format: moduleFormat(own) ?? 'module' }
      }
      const resolved = next(specifier, context)
      if (!resolved.url.startsWith('file:') || resolved.url.includes('/node_modules/')) return resolved
      const v = versionOf(resolved.url) ?? (context.parentURL?.startsWith('file:') && versionOf(context.parentURL))
      if (!v) return resolved
      const url = new URL(resolved.url)
      url.searchParams.set('wb-v', v)
      // A .whiteboard folder has no package.json of its own to say these are ES modules, so Node goes
      // by the nearest one above it: in a repository whose package.json is CommonJS (no "type"), it
      // would load the config as CommonJS and fail on its imports. What is in .whiteboard/ is always
      // a module, by its extension; other local files keep the format their package gives them.
      const inProject = url.pathname.split('/').includes('.whiteboard')
      return { ...resolved, url: url.href, format: inProject ? moduleFormat(url.pathname) : resolved.format ?? moduleFormat(url.pathname) }
    },
  })
}

function moduleFormat(file: string): ModuleFormat | undefined {
  if (/\.[mc]?ts$/.test(file)) return file.endsWith('.cts') ? 'commonjs-typescript' : 'module-typescript'
  if (/\.c?js$/.test(file)) return file.endsWith('.cjs') ? 'commonjs' : 'module'
  return undefined
}

let version = 0

/** Import `file` and everything local it imports afresh. */
export function importFresh(file: string): Promise<any> {
  installHooks()
  return import(`${pathToFileURL(file).href}?wb-v=${++version}`)
}
