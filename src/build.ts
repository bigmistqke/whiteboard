// Pages rendered once (`whiteboard build`), as files: each page's HTML with its links relative, and
// what it loads copied beside it, under its own ids and addresses (a site of its own: the server's is
// site.ts's servedSite). The page around a render is document.ts's, as for a page the server serves.
// See BuildConfig.
import fs from 'node:fs'
import path from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
import type { Project } from './config.ts'
import type { BuildConfig } from './define.ts'
import { RUNTIME, pageDocument, pluginParts, type SetUp } from './document.ts'
import { toPath, type LoadedConfig } from './loader.ts'
import { PACKAGE_DIR } from './package.ts'
import { pageSource, within } from './site.ts'

const ENGINE_DIR = PACKAGE_DIR
const TYPESCRIPT = /\.m?ts$/i
const typeScriptModule = (file: string): string => stripTypeScriptTypes(fs.readFileSync(file, 'utf8'))

/** What a build made. */
export interface BuildResult {
  /** the folder the site is in */
  out: string
  /** each page, and the file it became */
  pages: { file: string; to: string }[]
  /** what didn't fit: a link to a page outside the build, no index.html */
  warnings: string[]
}

/** What a build takes from the project's server: its config, its plugins set up, whether it serves the project's files. */
export interface BuildFrom {
  project: Project
  config(): Promise<LoadedConfig>
  hooks(): Promise<SetUp[]>
  files(): boolean
}

/** What a build leaves out unless told otherwise: what is for writing a page, not for reading it. */
const BUILD_SKIP = ['form', 'chat', 'comments', 'draft']
/** In the folder a build writes, so that a next build knows it may replace it. */
const BUILD_MARK = '.whiteboard-build'

export async function build(
  { project, config, hooks: setUp, files: served }: BuildFrom,
  options: BuildConfig = {},
): Promise<BuildResult> {
  const cfg = await config()
  if (cfg.errors.length) throw new Error(`the config failed to load: ${(cfg.errors[0] as Error).message}`)
  if (!cfg.pages) throw new Error('the config has no pages renderer')
  const pages = cfg.pages
  const defined = <T>(...xs: (T | undefined)[]) => xs.find(x => x !== undefined)
  const patterns = defined(options.pages, cfg.build.pages) ?? []
  const skip = new Set(defined(options.skip, cfg.build.skip) ?? BUILD_SKIP)
  const outDir = path.resolve(project.dir, defined(options.out, cfg.build.out) ?? 'site')
  if (!patterns.length)
    throw new Error(
      "nothing to build: name the pages, as globs from the project's folder (whiteboard build 'docs/**/*.md'), or set build.pages in the config",
    )
  const warnings: string[] = []

  // the pages: markdown files the globs match, but those a `!` glob leaves out
  const include = patterns.filter(p => !p.startsWith('!'))
  const exclude = patterns.filter(p => p.startsWith('!')).map(p => p.slice(1))
  const files = [
    ...new Set(include.flatMap(p => fs.globSync(p, { cwd: project.dir }).map(f => path.resolve(project.dir, f)))),
  ]
    .filter(f => /\.(md|markdown)$/i.test(f) && fs.statSync(f).isFile())
    .filter(f => !exclude.some(g => path.matchesGlob(path.relative(project.dir, f), g)))
    .sort()
  if (!files.length) throw new Error(`no markdown files match ${patterns.join(' ')}`)
  // each at its place below the folder they share; a README or index is its folder's index.html
  const base = files.map(path.dirname).reduce((a, b) => {
    while (!within(b, a)) a = path.dirname(a)
    return a
  })
  const outOf = (file: string) => {
    const rel = path.relative(base, file)
    return path.join(
      outDir,
      /^(readme|index)\.(md|markdown)$/i.test(path.basename(rel))
        ? path.join(path.dirname(rel), 'index.html')
        : rel.replace(/\.(md|markdown)$/i, '.html'),
    )
  }
  const built = new Map(files.map(f => [f, outOf(f)]))

  // the folder it writes: new, empty, or what an earlier build wrote
  if (fs.existsSync(outDir)) {
    if (fs.readdirSync(outDir).length && !fs.existsSync(path.join(outDir, BUILD_MARK)))
      throw new Error(`${outDir} has files a build didn't write: give another folder (--out), or empty it`)
    fs.rmSync(outDir, { recursive: true })
  }
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, BUILD_MARK), 'written by whiteboard build; the next build replaces this folder\n')

  // what a page loads, copied once: the package's files under _/whiteboard/, the project's under
  // _/project/, at their places there (so a stylesheet's url()s still hold); TypeScript as JavaScript
  const copied = new Map<string, string>()
  function copyAsset(file: string): string {
    const known = copied.get(file)
    if (known) return known
    const rel = within(file, ENGINE_DIR)
      ? path.join('_', 'whiteboard', path.relative(ENGINE_DIR, file))
      : within(file, project.dir)
        ? path.join('_', 'project', path.relative(project.dir, file))
        : path.join('_', 'files', path.basename(path.dirname(file)), path.basename(file))
    const dest = path.join(outDir, TYPESCRIPT.test(rel) ? rel.replace(/\.m?ts$/i, '.js') : rel)
    copied.set(file, dest)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    if (TYPESCRIPT.test(file)) fs.writeFileSync(dest, typeScriptModule(file))
    else fs.copyFileSync(file, dest)
    // a stylesheet's own files (fonts, images), at the same places beside it
    if (/\.css$/i.test(file)) {
      for (const m of fs.readFileSync(file, 'utf8').matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
        const ref = m[1]!
        if (/^(data:|[a-z][a-z0-9+.-]*:|\/|#)/i.test(ref)) continue
        const target = path.resolve(path.dirname(file), ref.replace(/[?#].*$/, ''))
        if (fs.existsSync(target) && fs.statSync(target).isFile()) copyAsset(target)
      }
    }
    return dest
  }
  /** a file beside the pages (an image), copied to its place below the site */
  function copyBeside(file: string): string | null {
    if (!within(file, base)) return null
    const dest = path.join(outDir, path.relative(base, file))
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(file, dest)
    }
    return dest
  }

  const hooks = await setUp()
  const result: BuildResult = { out: outDir, pages: [], warnings }
  for (const [file, dest] of built) {
    const here = path.dirname(dest)
    const relTo = (target: string) =>
      path.relative(here, target).split(path.sep).map(encodeURIComponent).join('/') || '.'
    const assetHere = (ref: string | URL) => relTo(copyAsset(toPath(ref)))
    const urlFor = (abs: string): string | null => {
      for (const candidate of [abs, abs + '.md']) {
        if (!fs.existsSync(candidate)) continue
        if (fs.statSync(candidate).isDirectory()) {
          const index = [...built.keys()].find(
            f => path.dirname(f) === candidate && /^(readme|index)\.(md|markdown)$/i.test(path.basename(f)),
          )
          if (index) return relTo(built.get(index)!)
          continue
        }
        if (built.has(candidate)) return relTo(built.get(candidate)!)
        if (/\.(md|markdown)$/i.test(candidate)) {
          warnings.push(
            `${path.relative(project.dir, file)} links to ${path.relative(project.dir, candidate)}, which is not in the build`,
          )
          return null
        }
        const copy = copyBeside(candidate)
        if (copy) return relTo(copy)
        warnings.push(
          `${path.relative(project.dir, file)} links to ${path.relative(project.dir, candidate)}, outside the built pages' folder`,
        )
        return null
      }
      return null
    }
    const id = within(file, project.pagesDir)
      ? path
          .relative(project.pagesDir, file)
          .split(path.sep)
          .join('/')
          .replace(/\.(md|markdown)$/i, '')
      : '-/' + path.relative(project.dir, file).split(path.sep).join('/')
    const stored = pageSource(id, file)
    if (stored.frontmatterError)
      warnings.push(`${path.relative(project.dir, file)}: frontmatter: ${stored.frontmatterError}`)
    const context = {
      project: { name: project.name, dir: project.dir, files: served() },
      asset: assetHere,
      urlFor,
      live: false,
      skip,
    }
    const rendered = await pages.render(stored, context)
    // a page without a heading of its own is named by its file (a README by its folder), not by
    // the id the server knows it by
    const named = /^(readme|index)\.(md|markdown)$/i.test(path.basename(file))
      ? path.basename(path.dirname(file))
      : path.basename(file).replace(/\.(md|markdown)$/i, '')
    const title = !rendered.title || rendered.title === id ? named : rendered.title
    const out = { ...rendered, title, html: String(rendered.html ?? ''), head: String(rendered.head ?? '') }
    // what the plugins add, but those the build leaves out, asked with no request: no browser
    // asked for this page (what is only for the project's own browser has nothing to add here)
    const parts = await pluginParts(hooks, null, {
      asset: assetHere,
      messages: [],
      leaveOut: skip,
      failed: message => warnings.push(`${path.relative(project.dir, file)}: ${message}`),
    })
    let doc = pageDocument(stored, { page: true, out, notices: [] }, parts, {
      live: false,
      base: '',
      asset: assetHere,
      runtime: assetHere(RUNTIME),
      title: project.name,
    })
    // a file a plugin named the server's way (its asset URL, /_/file/<path>): its copy
    doc = doc.replace(/\/_\/file(\/[^"'\s)<>]+)/g, (all, served: string) => {
      let file: string
      try {
        file = path.resolve(served.split('/').map(decodeURIComponent).join(path.sep))
      } catch {
        return all
      }
      return fs.existsSync(file) && fs.statSync(file).isFile() ? assetHere(file) : all
    })
    fs.mkdirSync(here, { recursive: true })
    fs.writeFileSync(dest, doc)
    result.pages.push({ file, to: dest })
  }
  if (![...built.values()].includes(path.join(outDir, 'index.html')))
    warnings.push('no README.md or index.md in the top folder: the site has no index.html')
  return result
}
