import { defineConfig } from '@bigmistqke/whiteboard/config'
import markboard from '@bigmistqke/whiteboard/markboard'
import terminal from '@bigmistqke/whiteboard/terminal'

export default defineConfig({
  name: 'whiteboard',
  renderers: [
    markboard(),
  ],
  extensions: [terminal()],
})
