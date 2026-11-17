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
