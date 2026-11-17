// Markdown pages: the markdown engine and the page in the browser, with the blocks the project's
// plugins bring (`:::name`, `::name`, `:name`, ```` ```name ````). The core builds it from the loaded
// config; it is still shaped as a renderer inside, which goes once the core renders markdown itself.
import type { Renderer } from '../src/define.ts'
import { builtFile } from '../src/package.ts'
import type { Block } from './types.ts'
import { resolveBlocks } from './templates.ts'
import { createDocs, createRender } from './render.ts'
import { formNames } from './markdown.ts'

/** A block as the plugins bring it: its name, and the plugin it comes from. */
export interface BlockEntry { name: string; block: Block<any>; plugin: string }

export interface Options {
  /** the blocks of the project's plugins, in plugin order */
  blocks: BlockEntry[]
  /** a stylesheet linked on every page, after the built-in ones */
  style?: URL | string
  /** stylesheets of plugins, linked on every page */
  styles?: (URL | string)[]
}

export default function markboard(options: Options): Renderer {
  const resolved = resolveBlocks(options.blocks)
  const templates = () => resolved
  return {
    name: 'markboard',
    render: createRender(templates, options.style, options.styles ?? []),
    docs: createDocs(templates),
    // the questions a page asks are its named forms; a form's answers are events of its name
    expects: page => (page.kind === 'page' ? formNames(page.source) : []),
    client: builtFile(import.meta.url, 'client/main.js'),
  }
}
