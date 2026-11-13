// The basic template set. In a visualize config:
//
//   import basic from '@visualize/templates-basic'
//   export default defineConfig({ templates: [basic()] })
//
// or pick single templates: `import { grid, form } from '@visualize/templates-basic'`.
import callout from './callout/index.ts'
import details from './details/index.ts'
import form from './form/index.ts'
import gallery from './gallery/index.ts'
import grid from './grid/index.ts'
import mermaid from './mermaid/index.ts'

export { callout, details, form, gallery, grid, mermaid }

export default function basic() {
  return [callout, details, form, gallery, grid, mermaid]
}
