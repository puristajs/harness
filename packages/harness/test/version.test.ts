import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { HARNESS_VERSION } from '../src/version.js'

describe('HARNESS_VERSION', () => {
  it('matches the package.json version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(HARNESS_VERSION).toBe(pkg.version)
  })
})
