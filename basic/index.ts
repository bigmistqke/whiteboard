// The basic renderer: pages are markdown, extended by templates. In a whiteboard config:
//
//   import basic from '@bigmistqke/whiteboard/basic'
//   export default defineConfig({ renderers: [basic()] })
//
// Its own templates are always there; add more, or replace one by giving yours the same name:
// `basic({ templates: [timeline] })`. Single templates can be imported too:
// `import { grid, form } from '@bigmistqke/whiteboard/basic'`. `code` (syntax highlighting for code
// blocks) takes options, so it is a function: `code({ themes })`, or `basic({ code: { themes } })`.
import type { Renderer } from '../src/define.ts'
import type { TemplateEntry } from './types.ts'
import callout from './callout/index.ts'
import code, { type Options as CodeOptions } from './code/index.ts'
import details from './details/index.ts'
import form from './form/index.ts'
import gallery from './gallery/index.ts'
import grid from './grid/index.ts'
import mermaid from './mermaid/index.ts'
import quiet from './quiet/index.ts'
import { resolveTemplates } from './templates.js'
import { createDocs, createRender } from './render.js'
import { formNames } from './markdown.js'

export { callout, code, details, form, gallery, grid, mermaid, quiet }
export type { CodeOptions }

export interface Options {
  /** more templates; one with the name of a built-in replaces it */
  templates?: TemplateEntry[]
  /** options for the code-block highlighter */
  code?: CodeOptions
  /** a stylesheet linked on every page, after basic's own: new URL('./style.css', import.meta.url) */
  style?: URL | string
}

export default function basic(options: Options = {}): Renderer {
  let resolved: ReturnType<typeof resolveTemplates> | undefined
  const templates = () => (resolved ??= resolveTemplates([
    { entries: [callout, code(options.code), details, form, gallery, grid, mermaid, quiet], source: 'basic' },
    { entries: options.templates ?? [], source: 'basic({ templates })' },
  ]))
  return {
    name: 'basic',
    render: createRender(templates, options.style),
    docs: createDocs(templates),
    // the questions a page asks are its named forms; a form's answers are events of its name
    expects: page => (page.kind === 'page' ? formNames(page.source) : []),
    client: new URL('./client/main.js', import.meta.url),
  }
}
