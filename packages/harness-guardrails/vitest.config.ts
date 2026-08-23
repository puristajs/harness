import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: [
      { find: '@purista/harness/testing', replacement: fileURLToPath(new URL('../harness/src/testing/index.ts', import.meta.url)) },
      { find: '@purista/harness', replacement: fileURLToPath(new URL('../harness/src/index.ts', import.meta.url)) }
    ]
  },
  test: {
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary']
    }
  }
})
