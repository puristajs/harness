import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: [
      { find: '@purista/harness-guardrails', replacement: fileURLToPath(new URL('../harness-guardrails/src/index.ts', import.meta.url)) }
    ]
  },
  test: { environment: 'node' }
})
