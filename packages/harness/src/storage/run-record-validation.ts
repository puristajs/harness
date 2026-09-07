import type { RunRecord, SerializedError } from '../models/state.js'
import { canonicalJson } from '../runtime/canonical-json.js'
import type { FinishRunPatch, TerminalApprovalReceiptV1 } from './types.js'
import type { RunCheckpoint } from './execution.js'

const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const runKeys = new Set([
  'id', 'sessionId', 'kind', 'target', 'startedAt', 'finishedAt', 'status', 'revision', 'input',
  'output', 'error', 'approvalReceipt', 'attempt', 'workerId', 'initialStepId', 'metadata',
])

/** @internal Validates one authoritative run after it crosses a storage boundary. */
export function assertStoredRunRecord(record: RunRecord, malformed: () => Error): void {
  if (!plain(record) || Reflect.ownKeys(record).some((key) => typeof key !== 'string' || !runKeys.has(key))
    || !validId(record.id) || !validId(record.sessionId) || !validId(record.target)
    || !['agent', 'workflow', 'child_task'].includes(record.kind) || !validTimestamp(record.startedAt)
    || !['running', 'waiting', 'interrupted', 'succeeded', 'failed', 'cancelled'].includes(record.status)
    || !positive(record.revision) || !json(record.input)
    || (record.metadata !== undefined && (!plain(record.metadata) || !json(record.metadata)))
    || (record.attempt !== undefined && !positive(record.attempt))
    || (record.workerId !== undefined && !validId(record.workerId))
    || (record.initialStepId !== undefined && !validId(record.initialStepId))) throw malformed()

  const terminal = record.status === 'succeeded' || record.status === 'failed' || record.status === 'cancelled'
  if (!terminal) {
    if (record.finishedAt !== undefined || Object.hasOwn(record, 'output') || record.error !== undefined
      || Object.hasOwn(record, 'approvalReceipt')) throw malformed()
    return
  }

  if (!validTimestamp(record.finishedAt)) throw malformed()
  if (record.status === 'succeeded') {
    if (!Object.hasOwn(record, 'output') || !json(record.output) || record.error !== undefined) throw malformed()
  } else if (Object.hasOwn(record, 'output') || !serializedError(record.error)) {
    throw malformed()
  }

  if (Object.hasOwn(record, 'approvalReceipt') && !approvalReceipt(record.approvalReceipt, record)) throw malformed()
}

/** @internal Validates and snapshots one checkpoint before persistence. */
export function normalizeRunCheckpoint(value: RunCheckpoint, malformed: () => Error): RunCheckpoint {
  if (!plain(value) || !exactKeys(value, [
    'runId', 'sessionId', 'leaseId', 'workerId', 'stepId', 'input', 'attempt', 'sequence',
    'output', 'replay', 'metadata', 'committedAt',
  ]) || !validId(value.runId) || !validId(value.sessionId) || !validId(value.leaseId)
    || !validId(value.workerId) || !validId(value.stepId) || !positive(value.attempt) || !positive(value.sequence)
    || !json(value.input)
    || (Object.hasOwn(value, 'output') && value.output === undefined)
    || (Object.hasOwn(value, 'replay') && value.replay === undefined)
    || (Object.hasOwn(value, 'metadata') && value.metadata === undefined)
    || (Object.hasOwn(value, 'committedAt') && value.committedAt === undefined)
    || (value.output !== undefined && !json(value.output))
    || (value.replay !== undefined && !json(value.replay))
    || (value.metadata !== undefined && (!plain(value.metadata) || !json(value.metadata)))
    || (value.committedAt !== undefined && !validTimestamp(value.committedAt))) throw malformed()
  return deepFreeze(structuredClone(value))
}

/** @internal Compares a checkpoint retry with the full installed record. */
export function sameInstalledRunCheckpoint(current: RunCheckpoint, proposed: RunCheckpoint): boolean {
  return canonicalJson(current) === canonicalJson({
    ...proposed,
    committedAt: proposed.committedAt ?? current.committedAt,
  })
}

/** @internal Validates an ordinary-run transition and supplies its terminal timestamp. */
export function normalizeFinishRunPatch(value: FinishRunPatch, now: () => string, malformed: () => Error): FinishRunPatch {
  if (!plain(value) || !exactKeys(value, ['status', 'finishedAt', 'output', 'error'])
    || !['running', 'waiting', 'interrupted', 'succeeded', 'failed', 'cancelled'].includes(value.status)) throw malformed()
  if (value.status === 'running' || value.status === 'waiting' || value.status === 'interrupted') {
    if (Object.hasOwn(value, 'finishedAt') || Object.hasOwn(value, 'output') || Object.hasOwn(value, 'error')) throw malformed()
    return deepFreeze(structuredClone(value))
  }
  if (Object.hasOwn(value, 'finishedAt') && value.finishedAt === undefined) throw malformed()
  const finishedAt = value.finishedAt ?? now()
  if (!validTimestamp(finishedAt)) throw malformed()
  if (value.status === 'succeeded') {
    if (!Object.hasOwn(value, 'output') || !json(value.output) || Object.hasOwn(value, 'error')) throw malformed()
  } else if (Object.hasOwn(value, 'output') || !serializedError(value.error)) {
    throw malformed()
  }
  return deepFreeze(structuredClone({ ...value, finishedAt }))
}

function approvalReceipt(value: TerminalApprovalReceiptV1 | undefined, run: RunRecord): boolean {
  if (!plain(value) || !exactKeys(value, [
    'schemaVersion', 'interruptId', 'resumeEventId', 'decisions', 'deploymentRevision',
    'compiledGraphDigest', 'sessionIdentityDigest', 'rootTarget',
  ]) || value.schemaVersion !== 1 || !validId(value.interruptId) || !validId(value.resumeEventId)
    || typeof value.deploymentRevision !== 'string' || value.deploymentRevision.length === 0
    || !/^sha256:[a-f0-9]{64}$/.test(value.compiledGraphDigest)
    || !/^sha256:[a-f0-9]{64}$/.test(value.sessionIdentityDigest)
    || !plain(value.rootTarget) || !exactKeys(value.rootTarget, ['kind', 'id'])
    || !['agent', 'workflow'].includes(value.rootTarget.kind) || !validId(value.rootTarget.id)
    || run.kind === 'child_task' || value.rootTarget.kind !== run.kind || value.rootTarget.id !== run.target
    || !Array.isArray(value.decisions)) return false
  let previous: string | undefined
  for (const decision of value.decisions) {
    if (!plain(decision) || !exactKeys(decision, ['approvalId', 'approved']) || !validId(decision['approvalId'])
      || typeof decision['approved'] !== 'boolean' || (previous !== undefined && previous >= decision['approvalId'])) return false
    previous = decision['approvalId']
  }
  return true
}

function serializedError(value: SerializedError | undefined): value is SerializedError {
  return plain(value) && exactKeys(value, ['code', 'message', 'category', 'retriable', 'meta'])
    && typeof value.code === 'string' && value.code.length > 0 && typeof value.message === 'string'
    && !(Object.hasOwn(value, 'category') && value.category === undefined)
    && !(Object.hasOwn(value, 'retriable') && value.retriable === undefined)
    && !(Object.hasOwn(value, 'meta') && value.meta === undefined)
    && (value.category === undefined || typeof value.category === 'string')
    && (value.retriable === undefined || typeof value.retriable === 'boolean')
    && (value.meta === undefined || (plain(value.meta) && json(value.meta)))
}

function json(value: unknown): boolean { try { canonicalJson(value); return true } catch { return false } }
function validId(value: unknown): value is string { return typeof value === 'string' && identifier.test(value) }
function validTimestamp(value: unknown): value is string { return typeof value === 'string' && timestamp.test(value) && new Date(value).toISOString() === value }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}
function exactKeys(value: object, allowed: readonly string[]): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === 'string' && allowed.includes(key))
}
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
