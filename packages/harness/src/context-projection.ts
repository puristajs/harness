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

/** Validates a projection policy without inspecting model-visible content. */
export function validateContextProjection(policy: ContextProjectionPolicy | undefined): boolean {
  if (!policy?.toolResultPruner) return true
  const { maxBytes, headBytes, tailBytes, marker = DEFAULT_MARKER } = policy.toolResultPruner
  return [maxBytes, headBytes, tailBytes].every((value) => Number.isFinite(value) && Number.isInteger(value) && value >= 0)
    && /^[\x00-\x7F]*$/.test(marker)
    && headBytes + tailBytes + 64 <= maxBytes
}

function utf8Prefix(value: string, limit: number): string {
  let result = ''
  for (const codePoint of value) {
    if (Buffer.byteLength(result + codePoint, 'utf8') > limit) break
    result += codePoint
  }
  return result
}

function utf8Suffix(value: string, limit: number): string {
  let result = ''
  for (const codePoint of Array.from(value).reverse()) {
    if (Buffer.byteLength(codePoint + result, 'utf8') > limit) break
    result = codePoint + result
  }
  return result
}

/** Returns an idempotent model-visible projection of oversized tool result text. */
export function projectToolResults(messages: readonly ModelMessage[], policy: ContextProjectionPolicy | undefined): readonly ModelMessage[] {
  const pruner = policy?.toolResultPruner
  if (!pruner) return messages
  const marker = pruner.marker ?? DEFAULT_MARKER
  return messages.map((message) => {
    if (message.role !== 'tool' || Buffer.byteLength(message.content, 'utf8') <= pruner.maxBytes || message.content.includes(`${marker} (`)) return message
    const head = utf8Prefix(message.content, pruner.headBytes)
    const tail = utf8Suffix(message.content, pruner.tailBytes)
    const omitted = Buffer.byteLength(message.content, 'utf8') - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(tail, 'utf8')
    return { ...message, content: `${head}${marker} (${omitted} UTF-8 bytes omitted)${tail}` }
  })
}
