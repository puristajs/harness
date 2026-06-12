import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@purista/harness/testing': fileURLToPath(new URL('../harness/src/testing/index.ts', import.meta.url)),
      '@purista/harness': fileURLToPath(new URL('../harness/src/index.ts', import.meta.url))
    }
  },
  test: {
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80
      }
    }
  }
})
