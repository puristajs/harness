import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    testTimeout: process.env['PURISTA_DOCKER_SANDBOX_TEST'] === '1' ? 120_000 : 5_000,
    hookTimeout: 120_000,
  },
})
