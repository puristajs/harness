import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@purista/harness': fileURLToPath(new URL('../../packages/harness/src/index.ts', import.meta.url))
    }
  },
  test: { environment: 'node' }
})
