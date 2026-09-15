import { z } from 'zod'

import { sandboxOwnerSchema, sandboxOwnerStringSchema, sandboxScopeSchema } from './ownership.js'
import type { SandboxOwner, SandboxScope } from './ownership.js'

const DEFAULT_CATALOG_ENTRIES = 10_000
const DEFAULT_SELECTOR_REVOCATION_RESERVE = 256
const DEFAULT_ACTIVE_SANDBOXES = 64
const DEFAULT_SNAPSHOTS_PER_OWNER = 32
const DEFAULT_RETAINED_SNAPSHOT_BYTES = 1_073_741_824
const DEFAULT_SNAPSHOT_BYTES = 268_435_456
const DEFAULT_UNPINNED_TTL_MS = 604_800_000
const DEFAULT_PAGE_LIMIT = 100
const MAXIMUM_PAGE_LIMIT = 1_000
const MAX_CURSOR_BYTES = 4_096

const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const nonNegativeSafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const opaqueReferenceSchema = z.string().min(1)
const abortSignalSchema = z.custom<AbortSignal>((value) => typeof value === 'object' && value !== null && 'aborted' in value, 'Expected an AbortSignal.')
const utcDateTimeSchema = z.string().datetime({ offset: true }).refine((value) => value.endsWith('Z'), 'Expected an ISO-8601 UTC timestamp.')

/** Operator selector with no wildcard or all-namespace form. */
export const sandboxSelectorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('owner'), owner: sandboxOwnerSchema }),
  z.strictObject({ kind: z.literal('tenant'), namespace: sandboxOwnerStringSchema, tenantId: sandboxOwnerStringSchema }),
  z.strictObject({ kind: z.literal('principal'), namespace: sandboxOwnerStringSchema, tenantId: sandboxOwnerStringSchema.optional(), principalId: sandboxOwnerStringSchema })
])

/** Exact owner, tenant, or principal administrative selection. */
export type SandboxSelector = z.output<typeof sandboxSelectorSchema>

/** Kind of resource exposed through an adapter-owned sandbox catalog. */
export const sandboxResourceKindSchema = z.enum(['sandbox', 'workspace', 'snapshot'])

/** Truthful lifecycle state exposed through an adapter-owned sandbox catalog. */
export const sandboxResourceStateSchema = z.enum(['provisioning', 'active', 'paused', 'terminal', 'cleanup_pending', 'deleted', 'state_lost'])

/** Content-free resource summary returned only from trusted administration APIs. */
export const sandboxResourceSummarySchema = z.strictObject({
  resourceId: opaqueReferenceSchema,
  kind: sandboxResourceKindSchema,
  owner: sandboxOwnerSchema,
  scope: sandboxScopeSchema.optional(),
  state: sandboxResourceStateSchema,
  createdAt: utcDateTimeSchema,
  updatedAt: utcDateTimeSchema,
  expiresAt: utcDateTimeSchema.optional(),
  sizeBytes: nonNegativeSafeIntegerSchema.optional(),
  pinned: z.boolean()
}).superRefine((value, context) => {
  if (value.kind === 'sandbox' && value.scope === undefined) {
    context.addIssue({ code: 'custom', path: ['scope'], message: 'Sandbox resources require a scope.' })
  }
  if (value.kind === 'workspace' && value.scope !== undefined) {
    context.addIssue({ code: 'custom', path: ['scope'], message: 'Workspace resources cannot carry a sandbox scope.' })
  }
  if (value.scope && !sameSandboxOwner(value.owner, value.scope.owner)) {
    context.addIssue({ code: 'custom', path: ['scope', 'owner'], message: 'A resource scope must retain the exact resource owner incarnation.' })
  }
})

/** Administrative resource summary with no provider reference or path. */
export type SandboxResourceSummary = z.output<typeof sandboxResourceSummarySchema>

/** Strict request to list adapter-owned sandbox resources. */
export const sandboxListOptionsSchema = z.strictObject({
  selector: sandboxSelectorSchema,
  kind: sandboxResourceKindSchema.optional(),
  cursor: z.string().min(1).max(MAX_CURSOR_BYTES).optional(),
  limit: z.number().int().min(1).max(MAXIMUM_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  signal: abortSignalSchema.optional()
})

/** Input accepted by {@link SandboxAdministration.list}. */
export type SandboxListOptions = z.input<typeof sandboxListOptionsSchema>

/** Stable administrative resource page. */
export const sandboxResourcePageSchema = z.strictObject({
  items: z.array(sandboxResourceSummarySchema).readonly(),
  nextCursor: z.string().min(1).max(MAX_CURSOR_BYTES).optional()
})

/** Stable administrative resource page. */
export type SandboxResourcePage = z.output<typeof sandboxResourcePageSchema>

/** Strict request to purge all resources selected by an exact owner tuple. */
export const sandboxPurgeOptionsSchema = z.strictObject({
  selector: sandboxSelectorSchema,
  idempotencyKey: opaqueReferenceSchema,
  limit: z.number().int().min(1).max(MAXIMUM_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  signal: abortSignalSchema.optional()
})

/** Input accepted by {@link SandboxAdministration.purge}. */
export type SandboxPurgeOptions = z.input<typeof sandboxPurgeOptionsSchema>

/** Truthful cumulative purge result; pending work always includes a retry delay. */
export const sandboxPurgeResultSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('cleanup_pending'), deletedResources: z.number().int().min(0), remainingResources: z.number().int().min(0), retryAfterMs: positiveSafeIntegerSchema }),
  z.strictObject({ state: z.literal('completed'), deletedResources: z.number().int().min(0), remainingResources: z.number().int().min(0) })
]).superRefine((value, context) => {
  if (value.state === 'completed' && value.remainingResources !== 0) {
    context.addIssue({ code: 'custom', path: ['remainingResources'], message: 'A completed purge cannot retain resources.' })
  }
})

/** Truthful cumulative purge result. */
export type SandboxPurgeResult = z.output<typeof sandboxPurgeResultSchema>

/** Strict bounded request to sweep adapter-owned eligible resources. */
export const sandboxSweepOptionsSchema = z.strictObject({
  cursor: z.string().min(1).max(MAX_CURSOR_BYTES).optional(),
  limit: z.number().int().min(1).max(MAXIMUM_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  signal: abortSignalSchema.optional()
})

/** Input accepted by {@link SandboxAdministration.sweep}. */
export type SandboxSweepOptions = z.input<typeof sandboxSweepOptionsSchema>

/** Bounded sweep result without resource identity leakage. */
export const sandboxSweepResultSchema = z.strictObject({
  examinedResources: z.number().int().min(0),
  deletedResources: z.number().int().min(0),
  pendingResources: z.number().int().min(0),
  nextCursor: z.string().min(1).max(MAX_CURSOR_BYTES).optional()
})

/** Bounded sweep result without resource identity leakage. */
export type SandboxSweepResult = z.output<typeof sandboxSweepResultSchema>

/** Exact-owner request to delete one opaque snapshot reference. */
export const sandboxSnapshotDeleteOptionsSchema = z.strictObject({
  owner: sandboxOwnerSchema,
  snapshotId: opaqueReferenceSchema,
  signal: abortSignalSchema.optional()
})

/** Input accepted by {@link SandboxAdministration.deleteSnapshot}. */
export type SandboxSnapshotDeleteOptions = z.output<typeof sandboxSnapshotDeleteOptionsSchema>

/** Trusted adapter administration surface; applications authorize their operators before calling it. */
export interface SandboxAdministration {
  list(options: SandboxListOptions): Promise<SandboxResourcePage>
  purge(options: SandboxPurgeOptions): Promise<SandboxPurgeResult>
  sweep(options?: SandboxSweepOptions): Promise<SandboxSweepResult>
  deleteSnapshot(options: SandboxSnapshotDeleteOptions): Promise<void>
}

/** Validated sandbox catalog limits with finite local-adapter defaults. */
export const sandboxAdministrationOptionsSchema = z.strictObject({
  maxCatalogEntries: positiveSafeIntegerSchema.default(DEFAULT_CATALOG_ENTRIES),
  selectorRevocationReserve: positiveSafeIntegerSchema.default(DEFAULT_SELECTOR_REVOCATION_RESERVE),
  maxActiveSandboxes: positiveSafeIntegerSchema.default(DEFAULT_ACTIVE_SANDBOXES)
}).superRefine((value, context) => {
  if (value.selectorRevocationReserve + 2 >= value.maxCatalogEntries) {
    context.addIssue({ code: 'custom', path: ['selectorRevocationReserve'], message: 'The revocation reserve must leave capacity for an owner barrier and purge progress.' })
  }
})

/** Optional sandbox catalog configuration accepted by supporting adapter factories. */
export type SandboxAdministrationOptions = z.input<typeof sandboxAdministrationOptionsSchema>

/** Validated workspace catalog limits with finite local-adapter defaults. */
export const workspaceAdministrationOptionsSchema = z.strictObject({
  maxCatalogEntries: positiveSafeIntegerSchema.default(DEFAULT_CATALOG_ENTRIES),
  selectorRevocationReserve: positiveSafeIntegerSchema.default(DEFAULT_SELECTOR_REVOCATION_RESERVE)
}).superRefine((value, context) => {
  if (value.selectorRevocationReserve + 2 >= value.maxCatalogEntries) {
    context.addIssue({ code: 'custom', path: ['selectorRevocationReserve'], message: 'The revocation reserve must leave capacity for an owner barrier and purge progress.' })
  }
})

/** Optional workspace catalog configuration accepted by supporting adapter factories. */
export type WorkspaceAdministrationOptions = z.input<typeof workspaceAdministrationOptionsSchema>

/** Validated snapshot retention bounds with the approved local defaults. */
export const sandboxSnapshotPolicySchema = z.strictObject({
  maxSnapshotsPerOwner: positiveSafeIntegerSchema.default(DEFAULT_SNAPSHOTS_PER_OWNER),
  maxRetainedSnapshotBytes: positiveSafeIntegerSchema.default(DEFAULT_RETAINED_SNAPSHOT_BYTES),
  maxSnapshotBytes: positiveSafeIntegerSchema.default(DEFAULT_SNAPSHOT_BYTES),
  unpinnedTtlMs: positiveSafeIntegerSchema.default(DEFAULT_UNPINNED_TTL_MS)
}).superRefine((value, context) => {
  if (value.maxSnapshotBytes > value.maxRetainedSnapshotBytes) {
    context.addIssue({ code: 'custom', path: ['maxSnapshotBytes'], message: 'The individual snapshot limit cannot exceed the retained snapshot limit.' })
  }
})

/** Optional snapshot retention configuration accepted by snapshot-capable adapters. */
export type SandboxSnapshotPolicy = z.input<typeof sandboxSnapshotPolicySchema>

export type { SandboxOwner, SandboxScope }

function sameSandboxOwner(left: SandboxOwner, right: SandboxOwner): boolean {
  return left.namespace === right.namespace
    && left.id === right.id
    && left.instanceId === right.instanceId
    && left.identity?.tenantId === right.identity?.tenantId
    && left.identity?.principalId === right.identity?.principalId
    && (left.identity === undefined) === (right.identity === undefined)
}
