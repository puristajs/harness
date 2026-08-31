import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@purista/harness-policy-opa/testing': fileURLToPath(new URL('../../packages/harness-policy-opa/src/testing/index.ts', import.meta.url)),
      '@purista/harness-policy-opa': fileURLToPath(new URL('../../packages/harness-policy-opa/src/index.ts', import.meta.url)),
      '@purista/harness': fileURLToPath(new URL('../../packages/harness/src/index.ts', import.meta.url)),
    },
  },
  test: { environment: 'node' },
})
