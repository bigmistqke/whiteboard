// Markdown pages: how the core turns a stored page into what the reader sees, with the blocks the
// project's plugins bring (`:::name`, `::name`, `:name`, ```` ```name ````). The loader makes one per
// loaded config (see loader.ts); the server renders with it.
import { resolveBlocks, type BlockEntry } from './blocks.ts'
import { createDocs, createMessageRender, createRender } from './render.ts'
import { formNames } from './markdown.ts'
import type { PageSource, RenderContext, Rendered, StoredPage } from '../define.ts'
import type { TextLink } from '../define.ts'

export interface PagesOptions {
  /** the blocks of the project's plugins, in plugin order */
  blocks: BlockEntry[]
  /** the project's stylesheet, linked on every page after the others */
  style?: URL | string
  /** the plugins' stylesheets, linked on every page */
  styles?: (URL | string)[]
  /** the plugins' text links (Plugin.links), each asked once per project folder */
  links?: ((ctx: { dir: string }) => TextLink[])[]
}

/** How the core renders pages for one loaded config. */
export interface Pages {
  /** a stored page as HTML, with its title, head additions and the data its browser part needs */
  render(page: StoredPage, ctx: RenderContext): Promise<Rendered>
  /** how pages are written, and which blocks the plugins bring: what `whiteboard docs` prints first */
  docs(ctx: RenderContext): string
  /** the questions a page asks: its named forms, whose answers are events of their name */
  questions(page: PageSource): string[]
  /** a message's markdown (a comment, a chat message) as HTML, and the stylesheets it needs */
  message(text: string, ctx: RenderContext): Promise<{ html: string; styles: string[] }>
}

export function createPages(options: PagesOptions): Pages {
  const resolved = resolveBlocks(options.blocks)
  const blocks = () => resolved
  return {
    render: createRender(blocks, options.style, options.styles ?? [], options.links ?? []),
    message: createMessageRender(blocks, options.links ?? []),
    docs: createDocs(blocks),
    questions: page => formNames(page.source),
  }
}
