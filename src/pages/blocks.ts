// The blocks of a project's plugins, checked and resolved into what the markdown engine uses.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Html } from '../html.ts'
import type { Block } from '../define.ts'
import { inPublic } from '../public.ts'

/** A block as the plugins bring it: its name, and the plugin it comes from. */
/** A block of a plugin, with the plugin's public folder, where its files are. */
export interface BlockEntry {
  name: string
  block: Block<any>
  plugin: string
  public: string
}

const NAME = /^[\w-]+$/

/** A block as the engine uses it: checked, with its files as absolute paths. */
export interface ResolvedBlock {
  name: string
  /** the block for code in general (`fence: 'any'`) */
  code: boolean
  /** it renders the code fences of its name (`fence: true` or `'any'`) */
  fences: boolean
  props: ((ctx: any) => unknown) | null
  html: ((ctx: any) => string | Html | null | Promise<string | Html | null>) | null
  /** what it shows on its own, for the ↗ of a window around it (Block.open) */
  open: ((ctx: any) => string | null) | null
  client: string | null
  style: string | null
  /** the plugin it comes from */
  source: string
}

export interface ResolvedBlocks {
  blocks: Map<string, ResolvedBlock>
  code: ResolvedBlock | null
}

/** Check and resolve one block into what the engine uses: its files in its plugin's public folder. */
function normalize({ name, block: b, plugin, public: dir }: BlockEntry): ResolvedBlock {
  if (typeof b !== 'object' || !b) throw new Error(`plugin ${plugin}: block "${name}" is not an object`)
  if (!NAME.test(name))
    throw new Error(`plugin ${plugin}: block name ${JSON.stringify(name)}: use letters, digits, - and _`)
  const file = (ref: URL | string | undefined, field: string) =>
    ref == null ? null : inPublic(dir, ref, `plugin ${plugin}, block "${name}": ${field}`)
  const files = { client: file(b.client, 'client'), style: file(b.style, 'style') }
  for (const [field, file] of Object.entries(files))
    if (file && !fs.existsSync(file))
      throw new Error(`plugin ${plugin}, block "${name}": ${field} file not found: ${file}`)
  return {
    name,
    code: b.fence === 'any',
    fences: b.fence === true || b.fence === 'any',
    props: typeof b.props === 'function' ? b.props.bind(b) : null,
    html: typeof b.html === 'function' ? b.html.bind(b) : null,
    open: typeof b.open === 'function' ? b.open.bind(b) : null,
    ...files,
    source: plugin,
  }
}

/**
 * Resolve the plugins' blocks. A block name is one plugin's: two plugins bringing the same block is
 * an error. `code` is the block for code fences no block claims by name: the last one with
 * `fence: 'any'`.
 */
export function resolveBlocks(entries: BlockEntry[]): ResolvedBlocks {
  const blocks = new Map<string, ResolvedBlock>()
  for (const entry of entries) {
    const n = normalize(entry)
    const other = blocks.get(n.name)
    if (other) throw new Error(`block "${n.name}" comes from two plugins: ${other.source} and ${n.source}`)
    blocks.set(n.name, n)
  }
  return { blocks, code: [...blocks.values()].findLast(t => t.code) ?? null }
}
