// Where this package is on disk. Its modules run from source in the repository and from dist/ once
// built, at different depths, so a path into the package is found from its root, never by counting
// folders up from a module.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function findRoot(from: string): string {
  for (let dir = from; ; dir = path.dirname(dir)) {
    try {
      if (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name === '@bigmistqke/whiteboard')
        return dir
    } catch {
      /* no package.json here, or not ours */
    }
    if (path.dirname(dir) === dir)
      throw new Error(`whiteboard: no package.json of @bigmistqke/whiteboard above ${from}`)
  }
}

/** The package's folder: where its package.json is. */
export const PACKAGE_DIR = findRoot(path.dirname(fileURLToPath(import.meta.url)))

/** A path inside the package. */
export const packagePath = (...parts: string[]) => path.join(PACKAGE_DIR, ...parts)

/**
 * Is the engine running from its TypeScript source (`bin/whiteboard.ts`), rather than from its build
 * (`dist/bin/whiteboard.js`, what an installed package runs)? Then what a config imports from the
 * package comes from source too (the `source` export conditions), so the two never mix.
 */
export const FROM_SOURCE = fileURLToPath(import.meta.url).endsWith('.ts')

/**
 * A browser file built from the module at `moduleUrl`'s folder: `name` in that folder's place in
 * dist/. The same whether the module runs from source (plugins/form/index.ts gives
 * dist/plugins/form/client.js) or from dist/ itself.
 */
/** A built-in plugin's public folder: its built browser modules and copied styles (build.ts). */
export const builtinPublic = (name: string): string => packagePath('dist', 'plugins', name, 'public')

/** This package's version, from its package.json: what a shared server records, and its takeover compares. */
export const VERSION: string = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8')).version

/** Compare two versions, x.y.z with an optional -pre: < 0 when a is older, 0 when the same, > 0 when newer. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [main, pre] = String(v).split('-', 2)
    return { nums: main!.split('.').map(n => Number(n) || 0), pre: pre ?? null }
  }
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (d) return Math.sign(d)
  }
  // a release is newer than its pre-releases
  if (x.pre === y.pre) return 0
  if (x.pre == null) return 1
  if (y.pre == null) return -1
  return x.pre < y.pre ? -1 : 1
}
