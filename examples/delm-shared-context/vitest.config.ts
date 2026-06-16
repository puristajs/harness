import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@purista/harness': fileURLToPath(new URL('../../packages/harness/src/index.ts', import.meta.url)),
      '@purista/harness-openai': fileURLToPath(new URL('../../packages/harness-openai/src/index.ts', import.meta.url))
    }
  },
  test: {
    environment: 'node'
  }
})
