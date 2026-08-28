import { z } from 'zod'

import type { HarnessIdentity } from '../identity/index.js'

const CONTROL_CHARACTER = /[\u0000-\u001F\u007F-\u009F]/
const CANONICAL_ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/
const SANDBOX_GROUP_ID = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/

function isSafeOwnerString(value: string): boolean {
  return value.length > 0 && new TextEncoder().encode(value).byteLength <= 256 && !CONTROL_CHARACTER.test(value)
}

/** A non-empty owner-key component that is safe to persist in a private catalog. */
export const sandboxOwnerStringSchema = z.string().refine(isSafeOwnerString, 'Expected a non-empty owner string no longer than 256 UTF-8 bytes without control characters.')

const harnessIdentityShape = z.strictObject({
  tenantId: sandboxOwnerStringSchema.optional(),
  principalId: sandboxOwnerStringSchema.optional()
}).superRefine((value, context) => {
  for (const key of ['tenantId', 'principalId'] as const) {
    if (Object.hasOwn(value, key) && value[key] === undefined) {
      context.addIssue({ code: 'custom', path: [key], message: 'Identity dimensions must be omitted rather than set to undefined.' })
    }
  }
})

const harnessIdentitySchema = z.custom<HarnessIdentity>(
  (value) => harnessIdentityShape.safeParse(value).success,
  'Expected a strict Harness identity.'
)

/** Validated group identifier for a configured sandbox-sharing policy. */
export const sandboxGroupIdSchema = z.string().regex(SANDBOX_GROUP_ID, 'Expected a configured sandbox group identifier.')

/** Exact immutable identity of one sandbox owner incarnation. */
export const sandboxOwnerSchema = z.strictObject({
  namespace: sandboxOwnerStringSchema,
  id: sandboxOwnerStringSchema,
  instanceId: z.string().regex(CANONICAL_ULID, 'Expected a canonical ULID.'),
  identity: harnessIdentitySchema.optional()
})

/** Exact owner identity retained by sandbox adapters and durable metadata. */
export type SandboxOwner = z.output<typeof sandboxOwnerSchema>

/** Filesystem partition selected beneath an immutable sandbox owner. */
export const sandboxPartitionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('shared') }),
  z.strictObject({ kind: z.literal('agent'), harnessName: sandboxOwnerStringSchema, id: sandboxOwnerStringSchema }),
  z.strictObject({ kind: z.literal('workflow'), harnessName: sandboxOwnerStringSchema, id: sandboxOwnerStringSchema }),
  z.strictObject({ kind: z.literal('group'), id: sandboxGroupIdSchema })
])

/** A shared, definition-private, or explicitly grouped filesystem partition. */
export type SandboxPartition = z.output<typeof sandboxPartitionSchema>

/** Owner-scoped lifecycle key kept local until the atomic Sandbox port cutover. */
export const sandboxScopeSchema = z.discriminatedUnion('lifetime', [
  z.strictObject({
    owner: sandboxOwnerSchema,
    partition: sandboxPartitionSchema,
    lifetime: z.literal('session')
  }),
  z.strictObject({
    owner: sandboxOwnerSchema,
    partition: sandboxPartitionSchema,
    lifetime: z.literal('run'),
    runId: sandboxOwnerStringSchema
  })
])

/** Owner-scoped lifecycle key used by the future atomic Sandbox port cutover. */
export type SandboxScope = z.output<typeof sandboxScopeSchema>

/** Sharing policy selected by a harness, definition, or child-task invocation. */
export type SandboxPolicy<G extends string = string> = 'inherit' | 'private' | { readonly group: G }

/** Trusted caller context supplied only to an external-owner authorization callback. */
export interface SandboxOwnerAuthorizationContext {
  readonly owner: SandboxOwner
  readonly identity?: HarnessIdentity
  readonly harnessName: string
  readonly sessionId: string
}

/** Typed sharing vocabulary and trusted external-owner authorization callback. */
export interface SandboxBindingOptions<G extends string = never> {
  readonly groups?: readonly G[]
  readonly defaultPolicy?: SandboxPolicy<G>
  readonly authorizeOwner?: (context: SandboxOwnerAuthorizationContext) => boolean | Promise<boolean>
}

const ownerAuthorizationCallbackSchema = z.custom<SandboxBindingOptions<string>['authorizeOwner']>(
  (value) => typeof value === 'function',
  'Expected an owner authorization callback.'
)

/** Strict runtime validation for the closed, non-generic binding option fields. */
export const sandboxBindingOptionsSchema = z.strictObject({
  groups: z.array(sandboxGroupIdSchema).max(64).readonly().optional(),
  defaultPolicy: z.union([
    z.literal('inherit'),
    z.literal('private'),
    z.strictObject({ group: sandboxGroupIdSchema })
  ]).optional(),
  authorizeOwner: ownerAuthorizationCallbackSchema.optional()
}).superRefine((value, context) => {
  if (value.groups && new Set(value.groups).size !== value.groups.length) {
    context.addIssue({ code: 'custom', path: ['groups'], message: 'Sandbox sharing groups must be unique.' })
  }
  if (typeof value.defaultPolicy === 'object' && (!value.groups || !value.groups.includes(value.defaultPolicy.group))) {
    context.addIssue({ code: 'custom', path: ['defaultPolicy', 'group'], message: 'The default sandbox group must be configured.' })
  }
})

/** Strict session input supplied before the later session/runtime integration cutover. */
export const sessionOptionsSchema = z.strictObject({
  identity: harnessIdentitySchema.optional(),
  sandboxOwner: sandboxOwnerSchema.optional()
})

/** Session input supplied before the later session/runtime integration cutover. */
export type SessionOptions = z.output<typeof sessionOptionsSchema>

/** Metadata-only owner registration request. */
export const sandboxOwnerRegistrationOptionsSchema = z.strictObject({
  owner: sandboxOwnerSchema,
  mode: z.enum(['create', 'attach']),
  signal: z.custom<AbortSignal>((value) => typeof value === 'object' && value !== null && 'aborted' in value, 'Expected an AbortSignal.').optional()
})

/** Metadata-only owner registration request used before sandbox compute is allocated. */
export type SandboxOwnerRegistrationOptions = z.output<typeof sandboxOwnerRegistrationOptionsSchema>

/** Immutable persisted owner binding for one Harness session incarnation. */
export const sessionSandboxBindingSchema = z.strictObject({
  owner: sandboxOwnerSchema,
  relation: z.enum(['owned', 'borrowed']),
  registration: z.enum(['pending', 'registered']),
  policyDigest: z.string().min(1),
  disposed: z.boolean()
}).superRefine((value, context) => {
  if (value.relation === 'borrowed' && value.registration !== 'registered') {
    context.addIssue({ code: 'custom', path: ['registration'], message: 'Borrowed sandbox bindings must already be registered.' })
  }
  if (value.relation === 'borrowed' && value.disposed) {
    context.addIssue({ code: 'custom', path: ['disposed'], message: 'Borrowed sandbox bindings cannot dispose their owner.' })
  }
})

/** Persisted sandbox binding retained with a Harness session record. */
export type SessionSandboxBinding = z.output<typeof sessionSandboxBindingSchema>
