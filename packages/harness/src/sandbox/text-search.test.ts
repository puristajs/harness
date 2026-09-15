import { describe, expect, it } from 'vitest'

import type { DirEntry } from '../harness/types.js'
import { SANDBOX_TEXT_SEARCH_LIMITS, searchSandboxTextLocally } from './text-search.js'

const request = {
  path: '/workspace',
  pattern: 'needle',
  syntax: 'literal' as const,
  caseSensitive: true,
  maxResults: 100,
}

describe('sandbox text-search reference implementation', () => {
  it('measures pattern limits as UTF-8 bytes', async () => {
    await expect(searchSandboxTextLocally(
      { ...request, pattern: '🧭'.repeat(129) },
      access([], new Uint8Array()),
    )).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(searchSandboxTextLocally(
      { ...request, pattern: 'one\ntwo' },
      access([], new Uint8Array()),
    )).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(searchSandboxTextLocally(
      { ...request, path: '/workspace/../private' },
      access([], new Uint8Array()),
    )).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('reports oversized files and returned lines without silent omission', async () => {
    const oversized: DirEntry = { name: 'large.txt', path: '/workspace/large.txt', kind: 'file', size: SANDBOX_TEXT_SEARCH_LIMITS.maxFileBytes + 1 }
    const longLine = `needle${'x'.repeat(SANDBOX_TEXT_SEARCH_LIMITS.maxReturnedLineBytes + 10)}`
    const normal: DirEntry = { name: 'normal.txt', path: '/workspace/normal.txt', kind: 'file', size: Buffer.byteLength(longLine) }
    const result = await searchSandboxTextLocally(request, {
      async list() { return [oversized, normal] },
      async read(path) { return new TextEncoder().encode(path === normal.path ? longLine : '') },
    })
    expect(result).toMatchObject({
      complete: false,
      limitReasons: ['file_byte_limit', 'line_byte_limit'],
      scannedFiles: 1,
      matches: [{ path: normal.path, textTruncated: true }],
    })
    expect(Buffer.byteLength(result.matches[0]!.text)).toBeLessThanOrEqual(SANDBOX_TEXT_SEARCH_LIMITS.maxReturnedLineBytes)
  })

  it('keeps case folding and safe regex portable across adapters', async () => {
    const entries: DirEntry[] = [{ name: 'a.txt', path: '/workspace/a.txt', kind: 'file' }]
    await expect(searchSandboxTextLocally(
      { ...request, pattern: 'K', caseSensitive: false },
      access(entries, new TextEncoder().encode('k\nK\n')),
    )).resolves.toMatchObject({ matches: [{ line: 1 }] })
    await expect(searchSandboxTextLocally(
      { ...request, pattern: 'abc', syntax: 'safe_regex_v1', caseSensitive: false },
      access(entries, new Uint8Array()),
    )).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(searchSandboxTextLocally(
      { ...request, pattern: 'ä', syntax: 'safe_regex_v1' },
      access(entries, new Uint8Array()),
    )).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('stops before the aggregate scan limit without allocating duplicate files', async () => {
    const entries = Array.from({ length: 26 }, (_, index): DirEntry => ({
      name: `${index}.txt`,
      path: `/workspace/${String(index).padStart(2, '0')}.txt`,
      kind: 'file',
      size: SANDBOX_TEXT_SEARCH_LIMITS.maxFileBytes,
    }))
    const shared = new Uint8Array(SANDBOX_TEXT_SEARCH_LIMITS.maxFileBytes)
    const result = await searchSandboxTextLocally(request, access(entries, shared))
    expect(result).toMatchObject({
      complete: false,
      limitReasons: ['scan_byte_limit'],
      scannedFiles: 25,
      scannedBytes: SANDBOX_TEXT_SEARCH_LIMITS.maxScannedBytes,
    })
  })

  it('reports the file-count limit deterministically', async () => {
    const entries = Array.from({ length: SANDBOX_TEXT_SEARCH_LIMITS.maxFiles + 1 }, (_, index): DirEntry => ({
      name: `${index}.txt`, path: `/workspace/${String(index).padStart(5, '0')}.txt`, kind: 'file', size: 0,
    }))
    const result = await searchSandboxTextLocally(request, access(entries, new Uint8Array()))
    expect(result).toMatchObject({ complete: false, limitReasons: ['file_count_limit'], scannedFiles: SANDBOX_TEXT_SEARCH_LIMITS.maxFiles })
  })
})

function access(entries: readonly DirEntry[], bytes: Uint8Array) {
  return {
    async list() { return [...entries] },
    async read() { return bytes },
  }
}
