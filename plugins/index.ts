// The built-in plugins: what every project has, before its config's `plugins` (which add to them,
// and replace one of the same name: `code({ themes })` for the default `code`). The terminal and the
// Claude Code plugin are not among them: they run code, or are about one agent, so a project adds
// them itself.
import type { Plugin } from '../src/define.ts'
import callout from './callout/index.ts'
import chat from './chat/index.ts'
import code from './code/index.ts'
import comments from './comments/index.ts'
import details from './details/index.ts'
import forge from './forge/index.ts'
import form from './form/index.ts'
import gallery from './gallery/index.ts'
import grid from './grid/index.ts'
import iframe from './iframe/index.ts'
import mermaid from './mermaid/index.ts'
import quiet from './quiet/index.ts'
import windows from './window/index.ts'

export function builtins(): Plugin[] {
  return [
    callout(),
    chat(),
    code(),
    comments(),
    details(),
    forge(),
    form(),
    gallery(),
    grid(),
    iframe(),
    mermaid(),
    quiet(),
    windows(),
  ]
}
