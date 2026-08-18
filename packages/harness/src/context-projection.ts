import type { ModelMessage } from './ports/model-provider.js'

/** Retry-only, transient context reduction policy. */
export interface ContextProjectionPolicy {
  readonly toolResultPruner?: {
    readonly maxBytes: number
    readonly headBytes: number
    readonly tailBytes: number
    readonly marker?: string
  }
}

const DEFAULT_MARKER = '...[tool result pruned]...'
// `Buffer.byteLength` is a JavaScript number. Reserving its largest exact
// decimal representation keeps the validation independent from the source
// text while still bounding the rendered omission annotation exactly.
const MAX_OMITTED_BYTES_TEXT = String(Number.MAX_SAFE_INTEGER)
const OMITTED_BYTES_SUFFIX = ' UTF-8 bytes omitted)'
// Projection is transient request state. Content is model-visible, so it must
// never double as an idempotency marker: an ordinary tool result can contain
// the same text. A weak identity marker keeps repeated calls idempotent without
// trusting tool-controlled content.
const projectedMessages = new WeakSet<object>()

function projectionOverheadBytes(marker: string): number {
  return Buffer.byteLength(`${marker} (${MAX_OMITTED_BYTES_TEXT}${OMITTED_BYTES_SUFFIX}`, 'utf8')
}

/** Validates a projection policy without inspecting model-visible content. */
export function validateContextProjection(policy: ContextProjectionPolicy | undefined): boolean {
  if (!policy?.toolResultPruner) return true
  const { maxBytes, headBytes, tailBytes, marker = DEFAULT_MARKER } = policy.toolResultPruner
  return [maxBytes, headBytes, tailBytes].every((value) => Number.isFinite(value) && Number.isInteger(value) && value >= 0)
    && /^[\x00-\x7F]*$/.test(marker)
    && headBytes + tailBytes + projectionOverheadBytes(marker) <= maxBytes
}

function utf8Prefix(value: string, limit: number): string {
  let result = ''
  let bytes = 0
  for (const codePoint of value) {
    const nextBytes = Buffer.byteLength(codePoint, 'utf8')
    if (bytes + nextBytes > limit) break
    result += codePoint
    bytes += nextBytes
  }
  return result
}

function utf8Suffix(value: string, limit: number): string {
  let result = ''
  let bytes = 0
  for (const codePoint of Array.from(value).reverse()) {
    const nextBytes = Buffer.byteLength(codePoint, 'utf8')
    if (bytes + nextBytes > limit) break
    result = codePoint + result
    bytes += nextBytes
  }
  return result
}

/** Returns an idempotent model-visible projection of oversized tool result text. */
export function projectToolResults(messages: readonly ModelMessage[], policy: ContextProjectionPolicy | undefined): readonly ModelMessage[] {
  const pruner = policy?.toolResultPruner
  if (!pruner) return messages
  const marker = pruner.marker ?? DEFAULT_MARKER
  return messages.map((message) => {
    if (message.role !== 'tool' || Buffer.byteLength(message.content, 'utf8') <= pruner.maxBytes || projectedMessages.has(message)) return message
    const head = utf8Prefix(message.content, pruner.headBytes)
    const tail = utf8Suffix(message.content, pruner.tailBytes)
    const omitted = Buffer.byteLength(message.content, 'utf8') - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(tail, 'utf8')
    const content = `${head}${marker} (${omitted}${OMITTED_BYTES_SUFFIX}${tail}`
    // Policy validation reserves the largest possible decimal rendering for
    // `omitted`; retain this check as a local invariant should the policy type
    // ever evolve independently from its validator.
    if (Buffer.byteLength(content, 'utf8') > pruner.maxBytes) {
      throw new RangeError('Context projection exceeded its configured byte cap.')
    }
    const projected = { ...message, content }
    projectedMessages.add(projected)
    return projected
  })
}
