import { RE2JS } from 're2js'

import { OperationCancelledError, ValidationError } from '../errors/index.js'
import type { DirEntry } from '../harness/types.js'

/** Stable pattern modes supported by every `sandbox.text_search` adapter. */
export type SandboxTextSearchSyntax = 'literal' | 'safe_regex_v1'

/** Stable reasons why a successful text-search result is not exhaustive. */
export type SandboxTextSearchLimitReason =
  | 'result_limit'
  | 'scan_byte_limit'
  | 'file_byte_limit'
  | 'file_count_limit'
  | 'line_byte_limit'

/** Provider-neutral bounded text-search request. */
export interface SandboxTextSearchRequest {
  /** Absolute POSIX sandbox path to search recursively. */
  readonly path: string
  /** Literal text or a `safe_regex_v1` pattern. */
  readonly pattern: string
  /** Matching language. Use `literal` when regex operators are unnecessary. */
  readonly syntax: SandboxTextSearchSyntax
  /** Whether letter case must match. */
  readonly caseSensitive: boolean
  /** Maximum matches requested by the caller; cannot exceed the contract cap. */
  readonly maxResults: number
  /** Cancels search at the sandbox boundary. */
  readonly signal?: AbortSignal
}

/** One bounded matching line returned by sandbox text search. */
export interface SandboxTextSearchMatch {
  readonly path: string
  readonly line: number
  readonly text: string
  /** True when the returned line is an excerpt rather than the complete line. */
  readonly textTruncated: boolean
}

/** Bounded text-search result with explicit completeness. */
export interface SandboxTextSearchResult {
  readonly matches: readonly SandboxTextSearchMatch[]
  /** False whenever a contract limit skipped input or truncated returned text. */
  readonly complete: boolean
  readonly limitReasons: readonly SandboxTextSearchLimitReason[]
  readonly scannedFiles: number
  readonly scannedBytes: number
}

/** Fixed cross-adapter limits for the `sandbox.text_search` v1 contract. */
export const SANDBOX_TEXT_SEARCH_LIMITS = Object.freeze({
  maxPatternBytes: 512,
  maxResults: 100,
  maxReturnedLineBytes: 4 * 1024,
  maxFileBytes: 2 * 1024 * 1024,
  maxScannedBytes: 50 * 1024 * 1024,
  maxFiles: 10_000,
})

const unsupportedSafeRegex = /\\(?:[1-9]|[dDsSwWbB]|[pP]\{|k<)|\(\?/

/**
 * Validates the portable search contract before an adapter performs I/O.
 *
 * Adapters must call this at their own trust boundary even when Harness has
 * already validated a built-in `grep` proposal.
 *
 * @example
 * ```ts
 * validateSandboxTextSearchRequest({
 *   path: '/workspace',
 *   pattern: 'TODO',
 *   syntax: 'literal',
 *   caseSensitive: true,
 *   maxResults: 20,
 * })
 * ```
 */
export function validateSandboxTextSearchRequest(request: SandboxTextSearchRequest): void {
  const patternBytes = new TextEncoder().encode(request.pattern).byteLength
  if (!request.path.startsWith('/') || request.path.includes('\0') || request.path.includes('\\') || request.path.split('/').some(part => part === '.' || part === '..')) {
    invalid('path', 'Path must be an absolute POSIX sandbox path without traversal segments or backslashes.')
  }
  if (patternBytes === 0 || patternBytes > SANDBOX_TEXT_SEARCH_LIMITS.maxPatternBytes) {
    invalid('pattern', `Pattern must be between 1 and ${SANDBOX_TEXT_SEARCH_LIMITS.maxPatternBytes} UTF-8 bytes.`)
  }
  if (/[\0\r\n]/.test(request.pattern)) invalid('pattern', 'Pattern must describe one line and cannot contain NUL, CR, or LF.')
  if (request.syntax !== 'literal' && request.syntax !== 'safe_regex_v1') invalid('syntax', 'Unsupported text-search syntax.')
  if (typeof request.caseSensitive !== 'boolean') invalid('caseSensitive', 'caseSensitive must be a boolean.')
  if (!Number.isSafeInteger(request.maxResults) || request.maxResults <= 0 || request.maxResults > SANDBOX_TEXT_SEARCH_LIMITS.maxResults) {
    invalid('maxResults', `maxResults must be between 1 and ${SANDBOX_TEXT_SEARCH_LIMITS.maxResults}.`)
  }
  if (request.syntax === 'safe_regex_v1') {
    if (!request.caseSensitive) invalid('caseSensitive', 'safe_regex_v1 requires caseSensitive=true; use literal search for portable ASCII case folding.')
    if (!/^[\x00-\x7f]+$/.test(request.pattern)) invalid('pattern', 'safe_regex_v1 patterns must be ASCII for cross-adapter portability.')
    compileSafeRegex(request.pattern)
  }
}

/**
 * Compiles the versioned non-backtracking regex language used by adapters.
 *
 * @example
 * ```ts
 * const matcher = compileSafeRegex('error_[0-9]+')
 * matcher.test('error_42')
 * ```
 */
export function compileSafeRegex(pattern: string): RE2JS {
  if (!/^[\x00-\x7f]+$/.test(pattern)) invalid('pattern', 'safe_regex_v1 patterns must be ASCII for cross-adapter portability.')
  if (unsupportedSafeRegex.test(pattern)) {
    invalid('pattern', 'safe_regex_v1 does not support backreferences, lookaround, inline flags, named groups, shorthand classes, or Unicode property escapes.')
  }
  try {
    return RE2JS.compile(pattern)
  } catch {
    invalid('pattern', 'Pattern is not valid safe_regex_v1 syntax.')
  }
}

type LocalTextSearchAccess = {
  list(path: string, options: { recursive: true }): Promise<DirEntry[]>
  read(path: string): Promise<Uint8Array>
}

/** Internal data-local reference implementation for built-in local sandboxes. */
export async function searchSandboxTextLocally(
  request: SandboxTextSearchRequest,
  access: LocalTextSearchAccess,
): Promise<SandboxTextSearchResult> {
  validateSandboxTextSearchRequest(request)
  throwIfAborted(request.signal)
  const matcher = request.syntax === 'safe_regex_v1'
    ? compileSafeRegex(request.pattern)
    : undefined
  const literal = request.caseSensitive ? request.pattern : asciiLower(request.pattern)
  const matches: SandboxTextSearchMatch[] = []
  const reasons = new Set<SandboxTextSearchLimitReason>()
  let scannedFiles = 0
  let scannedBytes = 0

  const entries = (await access.list(request.path, { recursive: true }))
    .filter((entry): entry is DirEntry & { kind: 'file' } => entry.kind === 'file')
    .sort((left, right) => left.path.localeCompare(right.path))

  if (entries.length > SANDBOX_TEXT_SEARCH_LIMITS.maxFiles) reasons.add('file_count_limit')
  for (const entry of entries.slice(0, SANDBOX_TEXT_SEARCH_LIMITS.maxFiles)) {
    throwIfAborted(request.signal)
    if (entry.size !== undefined && entry.size > SANDBOX_TEXT_SEARCH_LIMITS.maxFileBytes) {
      reasons.add('file_byte_limit')
      continue
    }
    if (entry.size !== undefined && scannedBytes + entry.size > SANDBOX_TEXT_SEARCH_LIMITS.maxScannedBytes) {
      reasons.add('scan_byte_limit')
      break
    }

    const bytes = await access.read(entry.path)
    if (bytes.byteLength > SANDBOX_TEXT_SEARCH_LIMITS.maxFileBytes) {
      reasons.add('file_byte_limit')
      continue
    }
    if (scannedBytes + bytes.byteLength > SANDBOX_TEXT_SEARCH_LIMITS.maxScannedBytes) {
      reasons.add('scan_byte_limit')
      break
    }
    scannedFiles += 1
    scannedBytes += bytes.byteLength
    const lines = new TextDecoder().decode(bytes).split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      throwIfAborted(request.signal)
      const line = lines[index] ?? ''
      const matched = matcher ? matcher.test(line) : (request.caseSensitive ? line : asciiLower(line)).includes(literal)
      if (!matched) continue
      const excerpt = truncateUtf8(line, SANDBOX_TEXT_SEARCH_LIMITS.maxReturnedLineBytes)
      if (excerpt.truncated) reasons.add('line_byte_limit')
      matches.push({ path: entry.path, line: index + 1, text: excerpt.text, textTruncated: excerpt.truncated })
      if (matches.length >= request.maxResults) {
        reasons.add('result_limit')
        return result(matches, reasons, scannedFiles, scannedBytes)
      }
    }
  }
  return result(matches, reasons, scannedFiles, scannedBytes)
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoded = new TextEncoder().encode(value)
  if (encoded.byteLength <= maxBytes) return { text: value, truncated: false }
  let end = maxBytes
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1
  return { text: new TextDecoder().decode(encoded.subarray(0, end)), truncated: true }
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, character => character.toLowerCase())
}

function result(
  matches: readonly SandboxTextSearchMatch[],
  reasons: ReadonlySet<SandboxTextSearchLimitReason>,
  scannedFiles: number,
  scannedBytes: number,
): SandboxTextSearchResult {
  const limitReasons = [...reasons].sort()
  return { matches, complete: limitReasons.length === 0, limitReasons, scannedFiles, scannedBytes }
}

function invalid(path: string, message: string): never {
  throw new ValidationError('Sandbox text-search request is invalid.', {
    where: 'tool_input',
    issues: [{ path, message }],
  })
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new OperationCancelledError('Sandbox text search was cancelled.', { scope: 'sandbox' })
}
