import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'src/errors/**/*.test.ts',
      'src/logger/**/*.test.ts',
      'src/telemetry/**/*.test.ts',
      'src/ulid/**/*.test.ts',
      'src/eval/**/*.test.ts',
      'src/models/**/*.test.ts',
      'src/ports/**/*.test.ts',
      'src/sessions/**/*.test.ts',
      'src/tools/**/*.test.ts',
      'test/**/*.test.ts'
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      exclude: [
        'src/agents/index.ts',
        'src/models/registry.ts',
        'src/ports/**',
        'src/sessions/index.ts',
        'src/testing/**',
        'src/tools/index.ts',
        'src/tools/mcp/**',
        'src/workflows/index.ts'
      ],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80
      }
    }
  }
})
