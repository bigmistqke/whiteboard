import { defineConfig } from '@bigmistqke/whiteboard/config'
import markboard from '@bigmistqke/whiteboard/markboard'
import terminal from '@bigmistqke/whiteboard/terminal'
import claudeCode from '@bigmistqke/whiteboard/claude-code'
import forms from '@bigmistqke/whiteboard/forms'

export default defineConfig({
  name: 'whiteboard',
  renderers: [
    markboard(),
  ],
  extensions: [forms(), terminal({ command: 'claude' }), claudeCode()],
})
