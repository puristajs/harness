import { describe, expect, it } from 'vitest'
import { statusFromError } from './http.js'

describe('HTTP MCP error classification without network I/O', () => {
  it('uses only structured or explicit HTTP statuses', () => {
    expect(statusFromError({ status: 401 })).toBe(401)
    expect(statusFromError(new Error('HTTP 503'))).toBe(503)
    expect(statusFromError(new Error('request took 401ms'))).toBeUndefined()
  })
})
