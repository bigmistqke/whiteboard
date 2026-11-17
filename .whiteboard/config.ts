import { defineConfig } from '@bigmistqke/whiteboard'
import terminal from '@bigmistqke/whiteboard/terminal'
import claudeCode from '@bigmistqke/whiteboard/claude-code'

// comments, forms, chats and the rest are built in
export default defineConfig({
  name: 'whiteboard',
  plugins: [terminal(), claudeCode()],
})
