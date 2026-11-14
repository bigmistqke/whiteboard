import { defineConfig } from '@bigmistqke/whiteboard/config'
import markboard from '@bigmistqke/whiteboard/markboard'

export default defineConfig({
  name: 'whiteboard',
  renderers: [
    markboard(),
  ],
})
