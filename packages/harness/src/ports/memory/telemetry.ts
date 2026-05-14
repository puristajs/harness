import type { Span } from '@opentelemetry/api'
import { createHash } from 'node:crypto'
import type { HarnessError } from '../../errors/harness-error.js'
import { OperationCancelledError, StateError } from '../../errors/index.js'
import type { JsonValue } from '../../models/json.js'
import type { SpanAttrs } from '../../telemetry/index.js'
import type {
  CreateMemoryFacadeOptions,
  MemoryOperation,
  MemoryScope,
  MemorySearchQuery,
  MemoryWriteOptions
} from './types.js'
import { scopeCapability } from './validation.js'

export const CONTENT_ATTR_LIMIT = 8192

export function baseAttrs(opts: CreateMemoryFacadeOptions, scope: MemoryScope, operation: MemoryOperation): SpanAttrs {
  return {
    'harness.name': opts.harnessName,
    'harness.memory.provider': opts.adapter.info.id,
    'harness.memory.operation': operation,
    'harness.memory.scope': scope.kind,
    'harness.memory.capability': operation === 'search' ? 'memory.search' : scopeCapability[scope.kind],
    'harness.session.id': scope.sessionId,
    'harness.run.id': scope.runId,
    'harness.agent.id': scope.agentId,
    'harness.workflow.id': scope.workflowId
  }
}

export function resultAttributes(operation: MemoryOperation, result: unknown): SpanAttrs {
  if (operation === 'get') return { 'harness.memory.hit': result !== undefined }
  if (Array.isArray(result) && (operation === 'list' || operation === 'search')) return { 'harness.memory.result_count': result.length }
  return {}
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

export function shouldCaptureContent(mode: CreateMemoryFacadeOptions['contentCaptureMode']): boolean {
  return mode !== 'NO_CONTENT'
}

export function attachContent(
  span: Span,
  mode: CreateMemoryFacadeOptions['contentCaptureMode'],
  operation: MemoryOperation,
  key: string | undefined,
  content: { value?: JsonValue; writeOpts?: MemoryWriteOptions; query?: MemorySearchQuery } | undefined
): void {
  const attrs: SpanAttrs = {
    ...(key ? { 'harness.memory.key': key } : {}),
    ...(content?.value !== undefined ? { 'harness.memory.value': limitedJson(content.value) } : {}),
    ...(content?.query ? { 'harness.memory.query': content.query.text } : {})
  }
  if (mode === 'SPAN_ONLY' || mode === 'SPAN_AND_EVENT') {
    span.setAttributes(attrs)
  }
  if (mode === 'EVENT_ONLY' || mode === 'SPAN_AND_EVENT') {
    span.addEvent('harness.memory.content', cleanAttrs({ ...attrs, 'harness.memory.operation': operation }))
  }
}

export function normalizeMemoryError(
  adapter: CreateMemoryFacadeOptions['adapter'],
  operation: MemoryOperation,
  error: unknown
): unknown {
  if (error instanceof OperationCancelledError) return error
  if (isAbortError(error)) return new OperationCancelledError('Memory operation was cancelled.', { scope: 'memory' }, error)
  if (isHarnessError(error)) return error
  return new StateError('Memory adapter operation failed.', { op: `memory.${operation}`, adapter: 'memory', memory_provider: adapter.info.id }, error)
}

export function errorType(error: unknown): string {
  return isHarnessError(error) ? error.code : error instanceof Error ? error.name : 'Error'
}

function limitedJson(value: JsonValue): string | undefined {
  try {
    return JSON.stringify(value).slice(0, CONTENT_ATTR_LIMIT)
  } catch {
    return undefined
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function isHarnessError(error: unknown): error is HarnessError {
  return Boolean(error && typeof error === 'object' && 'code' in error && 'category' in error)
}

function cleanAttrs(attrs: SpanAttrs): Record<string, string | number | boolean | string[]> {
  const out: Record<string, string | number | boolean | string[]> = {}
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined) out[key] = value
  }
  return out
}
