import { z } from 'zod'
import { HarnessError } from '../errors/harness-error.js'

const externalWaitIdentifierPattern = /^[A-Za-z0-9_.:@/-]+$/

/** Validated opaque identifier used by durable external-wait records. */
export const externalWaitIdentifierSchema = z.string().min(1).max(200).regex(externalWaitIdentifierPattern)

/** UTC ISO-8601 timestamp with mandatory millisecond precision. */
export const externalWaitTimestampSchema = z.string().refine(
  (value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
  'Expected a UTC ISO-8601 timestamp with millisecond precision.'
)

/** Terminal result accepted by a durable external wait. */
export const externalWaitOutcomeSchema = z.enum(['approved', 'rejected', 'expired', 'cancelled'])
export type ExternalWaitOutcome = z.output<typeof externalWaitOutcomeSchema>

/** State persisted by an external-wait adapter. */
export const externalWaitStatusSchema = z.union([z.literal('waiting'), externalWaitOutcomeSchema])
export type ExternalWaitStatus = z.output<typeof externalWaitStatusSchema>

/** Opaque, non-content request stored by an external-wait adapter. */
export const externalWaitRequestSchema = z.object({
  waitId: externalWaitIdentifierSchema,
  kind: externalWaitIdentifierSchema,
  schemaVersion: externalWaitIdentifierSchema,
  definitionVersion: externalWaitIdentifierSchema,
  deadline: externalWaitTimestampSchema
}).strict()
export type ExternalWaitRequest = z.output<typeof externalWaitRequestSchema>

/** Harness-owned run/session binding added when persisting a public wait request. */
export const boundExternalWaitRequestSchema = externalWaitRequestSchema.extend({
  runId: externalWaitIdentifierSchema,
  sessionId: externalWaitIdentifierSchema
}).strict()
export type BoundExternalWaitRequest = z.output<typeof boundExternalWaitRequestSchema>

/** Idempotent terminal delivery from the application-owned review transport. */
export const externalWaitSignalSchema = z.object({
  waitId: externalWaitIdentifierSchema,
  eventId: externalWaitIdentifierSchema,
  outcome: externalWaitOutcomeSchema,
  observedAt: externalWaitTimestampSchema.optional()
}).strict()
export type ExternalWaitSignal = z.output<typeof externalWaitSignalSchema>

const externalWaitWaitingSchema = externalWaitRequestSchema.extend({
  status: z.literal('waiting'),
  createdAt: externalWaitTimestampSchema
}).strict()

function signaledExternalWaitSchema<const T extends ExternalWaitOutcome>(status: T) {
  return externalWaitRequestSchema.extend({
    status: z.literal(status),
    createdAt: externalWaitTimestampSchema,
    resolvedAt: externalWaitTimestampSchema,
    eventId: externalWaitIdentifierSchema
  }).strict()
}

const externalWaitAutomaticExpirySchema = externalWaitRequestSchema.extend({
  status: z.literal('expired'),
  createdAt: externalWaitTimestampSchema,
  resolvedAt: externalWaitTimestampSchema
}).strict()

/** Exact, safe snapshot returned by a wait adapter. */
export const externalWaitSnapshotSchema = z.union([
  externalWaitWaitingSchema,
  signaledExternalWaitSchema('approved'),
  signaledExternalWaitSchema('rejected'),
  signaledExternalWaitSchema('expired'),
  signaledExternalWaitSchema('cancelled'),
  externalWaitAutomaticExpirySchema
])
export type ExternalWaitSnapshot = z.output<typeof externalWaitSnapshotSchema>

/** Terminal subset returned from a completed workflow wait. */
export const externalWaitResolvedSchema = z.union([
  signaledExternalWaitSchema('approved'),
  signaledExternalWaitSchema('rejected'),
  signaledExternalWaitSchema('expired'),
  signaledExternalWaitSchema('cancelled'),
  externalWaitAutomaticExpirySchema
])
export type ExternalWaitResolved = z.output<typeof externalWaitResolvedSchema>

/** Idempotent registration result. */
export const externalWaitRegistrationSchema = z.object({
  created: z.boolean(),
  snapshot: externalWaitSnapshotSchema
}).strict()
export type ExternalWaitRegistration = z.output<typeof externalWaitRegistrationSchema>

/** Result of one idempotent terminal signal attempt. */
export const externalWaitSignalResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('applied'), snapshot: externalWaitSnapshotSchema }).strict(),
  z.object({ kind: z.literal('duplicate'), snapshot: externalWaitSnapshotSchema }).strict(),
  z.object({ kind: z.literal('already_terminal'), snapshot: externalWaitSnapshotSchema }).strict(),
  z.object({ kind: z.literal('not_found') }).strict()
])
export type ExternalWaitSignalResult = z.output<typeof externalWaitSignalResultSchema>

type ExternalWaitWaiting = z.output<typeof externalWaitWaitingSchema>

/** Error raised for an invalid or unavailable generic external-wait operation. */
export class ExternalWaitError extends HarnessError {
  public constructor(
    message: string,
    public readonly reason: 'invalid_request' | 'invalid_snapshot' | 'request_conflict' | 'adapter_unavailable' | 'durable_required'
  ) {
    super({ code: 'EXTERNAL_WAIT_ERROR', category: 'state', retriable: false, message, meta: { reason } })
  }
}

/** Thrown to suspend a durable workflow after a waiting state was persisted. */
export class ExternalWaitPendingError extends HarnessError {
  public readonly snapshot: ExternalWaitWaiting

  public constructor(snapshot: ExternalWaitWaiting, public readonly runId: string) {
    super({
      code: 'EXTERNAL_WAIT_PENDING', category: 'state', retriable: true,
      message: 'Workflow is waiting for an external signal.',
      meta: { kind: snapshot.kind, status: snapshot.status }
    })
    this.snapshot = snapshot
  }
}

/** Validates and projects one public request before telemetry or persistence. */
export function validateExternalWaitRequest(request: unknown): ExternalWaitRequest {
  return parseExternalWait(externalWaitRequestSchema, request, 'invalid_request')
}

/** Validates the Harness-owned extension without allowing caller-defined fields. */
export function validateBoundExternalWaitRequest(request: unknown): BoundExternalWaitRequest {
  return parseExternalWait(boundExternalWaitRequestSchema, request, 'invalid_request')
}

/** Validates one terminal application delivery before telemetry or storage access. */
export function validateExternalWaitSignal(signal: unknown): ExternalWaitSignal {
  return parseExternalWait(externalWaitSignalSchema, signal, 'invalid_request')
}

/** Validates one public wait identifier before looking up storage state. */
export function validateExternalWaitId(waitId: unknown): string {
  return parseExternalWait(externalWaitIdentifierSchema, waitId, 'invalid_request')
}

/** Validates cancellation arguments and maps them through the canonical signal reducer. */
export function createExternalWaitCancellation(waitId: unknown, eventId: unknown, observedAt?: unknown): ExternalWaitSignal {
  return validateExternalWaitSignal({
    waitId,
    eventId,
    outcome: 'cancelled',
    ...(observedAt === undefined ? {} : { observedAt })
  })
}

/** Validates a storage-adapter readback before it is exposed or emitted. */
export function validateExternalWaitSnapshot(snapshot: unknown): ExternalWaitSnapshot {
  return parseExternalWait(externalWaitSnapshotSchema, snapshot, 'invalid_snapshot')
}

/** Verifies that an adapter snapshot belongs to the exact requested wait. */
export function assertExternalWaitSnapshotRequest(snapshot: ExternalWaitSnapshot, request: ExternalWaitRequest): void {
  if (
    snapshot.waitId !== request.waitId
    || snapshot.kind !== request.kind
    || snapshot.schemaVersion !== request.schemaVersion
    || snapshot.definitionVersion !== request.definitionVersion
    || snapshot.deadline !== request.deadline
  ) {
    throw new ExternalWaitError('External wait adapter returned an invalid snapshot.', 'invalid_snapshot')
  }
}

/** Validates a storage-adapter registration result before it is exposed or emitted. */
export function validateExternalWaitRegistration(registration: unknown): ExternalWaitRegistration {
  return parseExternalWait(externalWaitRegistrationSchema, registration, 'invalid_snapshot')
}

/** Validates a storage-adapter delivery result before it is exposed. */
export function validateExternalWaitSignalResult(result: unknown): ExternalWaitSignalResult {
  return parseExternalWait(externalWaitSignalResultSchema, result, 'invalid_snapshot')
}

/** Returns the exact public request projection from a bound storage record. */
export function projectExternalWaitRequest(request: BoundExternalWaitRequest): ExternalWaitRequest {
  return {
    waitId: request.waitId,
    kind: request.kind,
    schemaVersion: request.schemaVersion,
    definitionVersion: request.definitionVersion,
    deadline: request.deadline
  }
}

/** Narrows a validated snapshot to the workflow-returnable terminal subset. */
export function asExternalWaitResolved(snapshot: ExternalWaitSnapshot): ExternalWaitResolved | undefined {
  return snapshot.status === 'waiting' ? undefined : snapshot
}

function parseExternalWait<T>(schema: z.ZodType<T>, value: unknown, reason: ExternalWaitError['reason']): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new ExternalWaitError(
      reason === 'invalid_snapshot' ? 'External wait adapter returned an invalid snapshot.' : 'External wait request is invalid.',
      reason
    )
  }
  return parsed.data
}
