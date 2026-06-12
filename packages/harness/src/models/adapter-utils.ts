import { ModelError, sanitizeProviderBody } from '../errors/index.js'
import type { JsonValue } from './json.js'
import type { TokenUsage, ToolCallSpec } from '../ports/model-provider.js'

/**
 * Shared helpers for first-party model adapter packages.
 *
 * Adapters import these from `@purista/harness` so error shapes, token usage
 * accounting, structured-JSON handling, and OpenAI-compatible stream tool-call
 * accumulation stay identical across providers.
 */

/** Identifies the provider call an adapter helper acts on behalf of. */
export interface AdapterCallContext {
  provider: string
  model: string
  method: string
}

/** Builds normalized token usage from optional provider token counts. */
export function toTokenUsage(inputTokens?: number, outputTokens?: number, totalTokens?: number): TokenUsage {
  const input = inputTokens ?? 0
  const output = outputTokens ?? 0
  return { inputTokens: input, outputTokens: output, totalTokens: totalTokens ?? input + output }
}

/**
 * Replaces raw provider/model content with a redaction-safe descriptor.
 *
 * Raw strings are model output (POR-07 forbids logging/tracing them), so they
 * collapse into `{ redacted, contentLength }`. Structured values pass through
 * the provider-body redaction rules.
 */
export function redactProviderContent(body: unknown): unknown {
  if (typeof body === 'string') return { redacted: true, contentLength: body.length }
  return sanitizeProviderBody(body)
}

/** Builds the shared `malformed_response` ModelError with a content-redacted provider body. */
export function malformedResponseError(ctx: AdapterCallContext, message: string, body: unknown, cause: unknown): ModelError {
  return new ModelError(message, {
    provider: ctx.provider,
    model: ctx.model,
    method: ctx.method,
    reason: 'malformed_response',
    providerBody: redactProviderContent(body)
  }, cause)
}

/** Parses provider JSON output, throwing the shared malformed-response error on failure. */
export function parseProviderJson(content: string, ctx: AdapterCallContext, message: string): JsonValue {
  try {
    return JSON.parse(content)
  } catch (error) {
    throw malformedResponseError(ctx, message, content, error)
  }
}

/** Wraps not-yet-valid JSON fragments for partial object stream chunks. */
export function safePartialJson(content: string): JsonValue {
  try {
    return JSON.parse(content)
  } catch {
    return { _partial: content }
  }
}

/** Drops the synthetic `harness_response` object tool from extracted tool calls. */
export function withoutObjectTool(calls: ToolCallSpec[] | undefined): ToolCallSpec[] | undefined {
  const filtered = calls?.filter((call) => call.name !== 'harness_response')
  return filtered && filtered.length > 0 ? filtered : undefined
}

/**
 * Per-index accumulator for OpenAI-compatible streamed tool-call fragments.
 *
 * The first delta carries `index`/`id`/`function.name` with partial or empty
 * arguments; later deltas carry only `index` and argument fragments. Fragments
 * are concatenated by index and parsed once at stream end.
 */
export type StreamToolCallState = Map<number, { id?: string; name?: string; args: string }>

/** Creates an empty OpenAI-compatible stream tool-call accumulator. */
export function createStreamToolCallState(): StreamToolCallState {
  return new Map()
}

/** Accumulates OpenAI-compatible `delta.tool_calls` fragments by index. */
export function accumulateStreamToolCallDeltas(state: StreamToolCallState, deltas: unknown[]): void {
  for (const delta of deltas as Array<{ index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } }>) {
    const index = typeof delta?.index === 'number' ? delta.index : 0
    const existing = state.get(index) ?? { args: '' }
    if (delta?.id) existing.id = String(delta.id)
    if (delta?.function?.name) existing.name = String(delta.function.name)
    if (typeof delta?.function?.arguments === 'string') existing.args += delta.function.arguments
    state.set(index, existing)
  }
}

/** Finalizes accumulated stream tool calls, parsing empty argument payloads as `{}`. */
export function finalizeStreamToolCalls(state: StreamToolCallState, ctx: AdapterCallContext, malformedMessage: string): ToolCallSpec[] {
  return [...state.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, call]) => call.id && call.name)
    .map(([, call]) => ({
      id: call.id as string,
      name: call.name as string,
      arguments: parseProviderJson(call.args || '{}', ctx, malformedMessage)
    }))
}
