import { defineConfig } from '@bigmistqke/whiteboard/config'
import basic from '@bigmistqke/whiteboard/basic'

export default defineConfig({
  name: 'whiteboard',
  templates: [
    basic(),
  ],
})
