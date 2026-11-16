import { defineConfig } from '@bigmistqke/whiteboard/config'
import markboard from '@bigmistqke/whiteboard/markboard'
import terminal from '@bigmistqke/whiteboard/terminal'
import claudeCode from '@bigmistqke/whiteboard/claude-code'
import comments from '@bigmistqke/whiteboard/comments'

export default defineConfig({
  name: 'whiteboard',
  renderers: [
    markboard(),
  ],
  plugins: [comments(), terminal({ command: 'claude' }), claudeCode()],
})
