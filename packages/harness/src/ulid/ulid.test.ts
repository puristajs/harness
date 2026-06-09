import { afterEach, describe, expect, it, vi } from 'vitest'

import { ulid } from './index.js'

describe('ulid', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns monotonically sortable ids', () => {
    const a = ulid()
    const b = ulid()
    const c = ulid()
    expect(a < b && b < c).toBe(true)
  })

  it('stays strictly increasing across a same-millisecond burst', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    const ids = Array.from({ length: 1000 }, () => ulid())
    for (let i = 1; i < ids.length; i += 1) {
      expect(ids[i] > ids[i - 1]).toBe(true)
    }
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('never emits a smaller id when the wall clock steps backward', () => {
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1_700_000_000_000)
    const before = ulid()
    now.mockReturnValue(1_699_999_999_000) // clock regressed by 1s
    const after = ulid()
    expect(after > before).toBe(true)
  })

  it('produces a fixed-width 26-character id', () => {
    const id = ulid()
    expect(id).toHaveLength(26)
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })
})
