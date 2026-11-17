// Where this package is on disk. Its modules run from source in the repository and from dist/ once
// built, at different depths, so a path into the package is found from its root, never by counting
// folders up from a module.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function findRoot(from: string): string {
  for (let dir = from; ; dir = path.dirname(dir)) {
    try {
      if (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name === '@bigmistqke/whiteboard') return dir
    } catch { /* no package.json here, or not ours */ }
    if (path.dirname(dir) === dir) throw new Error(`whiteboard: no package.json of @bigmistqke/whiteboard above ${from}`)
  }
}

/** The package's folder: where its package.json is. */
export const PACKAGE_DIR = findRoot(path.dirname(fileURLToPath(import.meta.url)))

/** A path inside the package. */
export const packagePath = (...parts: string[]) => path.join(PACKAGE_DIR, ...parts)

/**
 * Is this an installed package (in a node_modules folder)? Then Node won't run its TypeScript, and
 * everything runs from dist/. Otherwise (this repository, or a link to it) it runs from source.
 */
export const INSTALLED = PACKAGE_DIR.split(path.sep).includes('node_modules')

/**
 * A browser file built from the module at `moduleUrl`'s folder: `name` in that folder's place in
 * dist/. The same whether the module runs from source (markboard/form/index.ts gives
 * dist/markboard/form/client.js) or from dist/ itself.
 */
export function builtFile(moduleUrl: string, name: string): string {
  const rel = path.relative(PACKAGE_DIR, path.dirname(fileURLToPath(moduleUrl)))
  const inDist = rel === 'dist' || rel.startsWith('dist' + path.sep)
  return path.join(PACKAGE_DIR, inDist ? '' : 'dist', rel, name)
}
