// The basic template set. In a whiteboard config:
//
//   import basic from '@bigmistqke/whiteboard/basic'
//   export default defineConfig({ templates: [basic()] })
//
// or pick single templates: `import { grid, form } from '@bigmistqke/whiteboard/basic'`.
// `code` (syntax highlighting for code blocks) takes options, so it is a function: `code({ themes })`.
import callout from './callout/index.ts'
import code, { type Options as CodeOptions } from './code/index.ts'
import details from './details/index.ts'
import form from './form/index.ts'
import gallery from './gallery/index.ts'
import grid from './grid/index.ts'
import mermaid from './mermaid/index.ts'

export { callout, code, details, form, gallery, grid, mermaid }
export type { CodeOptions }

export interface Options {
  /** options for the code-block highlighter */
  code?: CodeOptions
}

export default function basic(options: Options = {}) {
  return [callout, code(options.code), details, form, gallery, grid, mermaid]
}
