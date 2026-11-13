import { defineConfig } from '@visualize/engine/config'
import basic from '@visualize/templates-basic'

export default defineConfig({
  name: 'visualize',
  templates: [
    basic(),
  ],
})
