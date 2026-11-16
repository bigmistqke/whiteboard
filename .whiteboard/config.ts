import { defineConfig } from '@bigmistqke/whiteboard/config'
import markboard from '@bigmistqke/whiteboard/markboard'
import terminal from '@bigmistqke/whiteboard/terminal'
import claudeCode from '@bigmistqke/whiteboard/claude-code'

export default defineConfig({
  name: 'whiteboard',
  renderers: [
    markboard(),
  ],
  extensions: [terminal({ command: 'claude' }), claudeCode()],
})
