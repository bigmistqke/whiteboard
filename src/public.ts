// A plugin's public folder: the one place its browser files are served from (its client modules,
// stylesheets, images, fonts; TypeScript there is served with its types stripped). The server
// serves what is inside a plugin's public folder, and nothing else of the plugin: not its server
// code, not the project's files beside it.
//
// A plugin says where (`public`); definePlugin defaults it to `public/` next to the module that
// calls it; a plugin that is a plain object (one written inline in the config, say) has the
// project's `.whiteboard/public/`. Its files (`client`, `style`, a block's) are named within it.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from './define.ts'

const asPath = (ref: URL | string): string =>
  ref instanceof URL || ref.startsWith('file:') ? fileURLToPath(ref) : ref

/** The folder a plugin's browser files are served from. */
export function publicDirOf(plugin: Plugin, wb: string): string {
  return path.resolve(plugin.public != null ? asPath(plugin.public) : path.join(wb, 'public'))
}

/** Is `file` inside `dir`? */
export const within = (file: string, dir: string): boolean => {
  const rel = path.relative(dir, file)
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * A file a plugin names, as a path: a name within its public folder (`style.css`,
 * `client/main.js`), or a URL or absolute path, which must be inside it. Anything else is an
 * error, said when the config loads, rather than a file that quietly isn't served.
 */
export function inPublic(dir: string, ref: URL | string, what: string): string {
  const file = typeof ref === 'string' && !ref.startsWith('file:') && !path.isAbsolute(ref) ? path.resolve(dir, ref) : path.resolve(asPath(ref))
  if (!within(file, dir)) throw new Error(`${what}: ${file} is not in its public folder (${dir}); a plugin's browser files live there`)
  return file
}
