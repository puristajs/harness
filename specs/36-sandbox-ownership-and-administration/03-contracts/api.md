# Public and persisted contracts

These are the complete semantic shapes, not implementation code. Existing
capability-specific `SandboxSessionFor<C>`, filesystem/process methods, snapshot
capabilities, `HarnessIdentity`, `AbortSignal`, and `HarnessError` remain reused.
No duplicate framework interfaces or optional old/new overloads are permitted.

## CTR-SOWN-POLICY

```ts
type SandboxPolicy<G extends string = string> = 'inherit' | 'private' | { group: G }

interface SandboxBindingOptions<G extends string = never> {
  groups?: readonly G[]
  defaultPolicy?: SandboxPolicy<G> // default: inherit
  authorizeOwner?: (context: SandboxOwnerAuthorizationContext) => boolean | Promise<boolean>
}

interface SandboxOwnerAuthorizationContext {
  owner: SandboxOwner
  identity?: HarnessIdentity
  harnessName: string
  sessionId: string
}

interface SessionOptions {
  identity?: HarnessIdentity
  sandboxOwner?: SandboxOwner
}
```

Builder: `.sandbox(adapter, options?)`, preserving the exact capability tuple of
`adapter` and literal `groups`. Keep the existing zero-argument `.sandbox()` as
auto-detection, equivalent to absent binding options; it is not a second port.
`AgentDefinition`, resolved agent-definition types, `WorkflowDefinition`, and
`ChildTaskStartOptions` add `sandbox?: SandboxPolicy<ConfiguredGroups<S>>`.
`getSession(id, options?: SessionOptions)` replaces the bare identity argument.
The callback is runtime composition only and is not serialized into manifests.

Group IDs: nonempty ASCII `[a-zA-Z][a-zA-Z0-9_.-]{0,63}`, at most 64 configured
groups, no duplicates. Closed schemas reject unknown properties and unknown group
values. Module definitions consume the host's group vocabulary; modules cannot
register another adapter or silently widen group literals to `string`. Static
module ID-prefixing affects private definition IDs, not explicitly named groups.

## CTR-SOWN-OWNER

```ts
interface SandboxOwner {
  namespace: string
  id: string
  instanceId: string
  identity?: HarnessIdentity
}

type SandboxPartition =
  | { kind: 'shared' }
  | { kind: 'agent'; harnessName: string; id: string }
  | { kind: 'workflow'; harnessName: string; id: string }
  | { kind: 'group'; id: string }

type SandboxScope = {
  owner: SandboxOwner
  partition: SandboxPartition
} & (
  | { lifetime: 'session'; runId?: never }
  | { lifetime: 'run'; runId: string }
)

interface SandboxOwnerRegistrationOptions {
  owner: SandboxOwner
  mode: 'create' | 'attach'
  signal?: AbortSignal
}

interface SessionSandboxBinding {
  owner: SandboxOwner
  relation: 'owned' | 'borrowed'
  registration: 'pending' | 'registered'
  policyDigest: string
  disposed: boolean
}
```

`Sandbox.registerOwner(options): Promise<void>` is required, metadata-only, and
idempotent. It may persist private catalog files, but never creates guest files,
workspaces or compute. Create is an operator/session-
creation authority; an active exact registration is a no-op, a revoked one is
denied, and attach of missing metadata is state loss. `namespace`, `id`, and
identity strings are nonempty, at most 256 UTF-8 bytes, without NUL/control
characters. Do not trim or normalize valid input. `instanceId` uses the existing
ULID generator; externally supplied values must validate as a canonical ULID.
Owner keys include all fields and optional-value presence. Re-registration under
another incarnation requires a new explicitly authorized owner; offboarding
selectors continue to deny a revoked principal/tenant regardless of incarnation.

`SessionRecord.sandboxBinding` is required for new session records; storage may
transition `pending` to `registered` only for the matching immutable incarnation.
The other binding fields cannot be updated. Borrowed registrations are always
`registered`; attach/authorization must pass before first resource use.
Session close retains its existing conditional `instanceId` delete semantics.
`disposed` starts false and may transition only to true after owned cleanup
completes; it never returns to false. Borrowed bindings stay false because they
cannot dispose the owner. It is a logical usability marker, not a provider
lifecycle record. Policy digest uses the binding/layout tuple for sessions and
the separately specified full graph digest for durable replay.

## CTR-SOWN-OPEN

`Sandbox.open` retains `scope`, `mode: 'create' | 'attach' | 'restore'`, and
`signal`, adding `identity?: HarnessIdentity` for the **acting** principal.
`SandboxOpenResult`, detach, terminate, dispositions, and process-preservation
results remain spec 34's public shapes. A scope no longer carries `harnessName`,
`sessionId`, `sessionInstanceId`, or `role` outside its owner; a task that borrows
must have the exact parent scope key, not a task-specific suffix.

An owner must already be registered. Create admits a never-allocated partition
of that owner, otherwise it attaches idempotently to its existing generation.
Missing or terminated prior generations fail; create is not reset. Attach never
allocates. Restore still requires a resumed committed workspace binding and
uses the existing generation/fencing contract. Acting identity is not part of
the resource key, but is validated against owner and revocation state and bound
to each attachment. The runtime's trusted caller provides it, never the model.

Terminate is scope-local and final. It does not delete sibling partitions,
snapshot inventory, or an entire owner. Owner purge is the complete deletion
operation. Snapshot creation records owner and source scope; snapshot resume is
allowed only within the exact same owner incarnation. Cross-owner cloning is
rejected rather than silently transferring another user's retained data.
`SandboxResumeOptions` additionally requires the same optional acting `identity`
field and admission/revocation checks as `SandboxOpenOptions`. Snapshot/hibernate
use the identity already bound to their session. Resume cannot bypass a revoked
principal by omitting its identity: owner/actor validation is identical to open.

## CTR-SOWN-ADMIN

```ts
type SandboxSelector =
  | { kind: 'owner'; owner: SandboxOwner }
  | { kind: 'tenant'; namespace: string; tenantId: string }
  | { kind: 'principal'; namespace: string; tenantId?: string; principalId: string }

type SandboxResourceKind = 'sandbox' | 'workspace' | 'snapshot'
type SandboxResourceState =
  | 'provisioning' | 'active' | 'paused' | 'terminal'
  | 'cleanup_pending' | 'deleted' | 'state_lost'

interface SandboxResourceSummary {
  resourceId: string // opaque administrative ID, never a provider reference
  kind: SandboxResourceKind
  owner: SandboxOwner
  scope?: SandboxScope // required for sandbox, optional source scope for snapshot
  state: SandboxResourceState
  createdAt: string // ISO-8601 UTC
  updatedAt: string
  expiresAt?: string
  sizeBytes?: number // omitted when unknown, never guessed as zero
  pinned: boolean
}

interface SandboxListOptions {
  selector: SandboxSelector
  kind?: SandboxResourceKind
  cursor?: string
  limit?: number // default 100, integer 1..1000
  signal?: AbortSignal
}

interface SandboxResourcePage {
  items: readonly SandboxResourceSummary[]
  nextCursor?: string
}

interface SandboxPurgeOptions {
  selector: SandboxSelector
  idempotencyKey: string
  limit?: number // resource deletions per attempt, default 100, 1..1000
  signal?: AbortSignal
}

interface SandboxPurgeResult {
  state: 'cleanup_pending' | 'completed'
  deletedResources: number // cumulative for this operation
  remainingResources: number // exact known inventory, reconciled before completed
  retryAfterMs?: number // required while pending, absent when completed
}

interface SandboxSweepOptions {
  cursor?: string
  limit?: number // default 100, 1..1000
  signal?: AbortSignal
}

interface SandboxSweepResult {
  examinedResources: number
  deletedResources: number
  pendingResources: number
  nextCursor?: string
}

interface SandboxSnapshotDeleteOptions {
  owner: SandboxOwner
  snapshotId: string
  signal?: AbortSignal
}

interface SandboxAdministration {
  list(options: SandboxListOptions): Promise<SandboxResourcePage>
  purge(options: SandboxPurgeOptions): Promise<SandboxPurgeResult>
  sweep(options?: SandboxSweepOptions): Promise<SandboxSweepResult>
  deleteSnapshot(options: SandboxSnapshotDeleteOptions): Promise<void>
}
```

`Sandbox.administration` and `DurableWorkspace.administration` are required
operator-only properties sharing this **sandbox-domain** interface. Each indexes
only resources it owns; workspace checkpoints appear as `kind: 'snapshot'` in
the workspace adapter's catalog. This is not a new service, package, registry
adapter, or generic resource framework. No administrative method is present on
`SandboxSession`, agent context, model tools, or tool-handler context.

Unknown kind on an adapter yields an empty list. Deleting an absent snapshot is
idempotent; deleting a pinned snapshot fails. Snapshot IDs are opaque logical
references, not arbitrary filesystem paths. Cursors are opaque, bounded to
4096 bytes, versioned, and bound to the exact selector/kind; mismatched or invalid
cursors are validation errors. Pagination is stable by immutable resource ID,
may omit records created behind the cursor during a sweep, and must not repeat
or skip unchanged records. Repeating a sweep from the beginning finds newly
eligible records. Purge uses its durable journal, not a caller pagination cursor.

Administration is a trusted composition API. Libraries do not authenticate HTTP
users or expose a management endpoint. Applications authorize operators before
calling it. A selector has no wildcard/all-namespace form. Principal selection
with omitted tenant matches only absent tenant, never all tenants.

## CTR-SOWN-WORKSPACE

Add required `sandboxOwner: SandboxOwner` and `sandboxPolicyDigest: string` to
`WorkspaceStartOptions` and `WorkspaceHandle`; round-trip both through durable
metadata and inspection. Add `sandboxPolicyDigest` to `WorkspaceCheckpoint` and
`DurableReplayCheckpoint`. Persist no provider IDs/fences in these fields.
Add `sandboxPartitions: readonly SandboxPartition[]` to `WorkspaceCheckpoint`
and `DurableReplayCheckpoint`; this is the committed membership manifest, sorted
by canonical key and without duplicates. Inspection exposes `sandboxOwner`,
`sandboxPolicyDigest`, `runId`, and `sessionId`. Administrative `resourceId` is
the existing opaque workspaceRef for a workspace and checkpointRef for a local
checkpoint; it is never a path or provider ID.

Add `DurableWorkspace.pinCheckpoint({ workspaceRef, checkpointRef, runId,
idempotencyKey, signal? }): Promise<void>` and
`releaseCheckpoint({ workspaceRef, checkpointRef, runId, idempotencyKey,
signal? }): Promise<void>`. Pins are logical run/checkpoint relationships, not
public leases. Both operations validate workspace/run ownership and are
idempotent. Pins survive adapter restart. Release requires proof from the caller
that a newer committed pin or a terminal durable result has been persisted;
runtime ordering and crash-reconciliation tests enforce this authority. An
administrative purge may override pins after revoking/stopping the owner.

Add `DurableWorkspace.finish({ workspaceRef, runId, status: 'succeeded' | 'failed'
| 'cancelled', idempotencyKey, signal? }): Promise<void>`. It validates exact
workspace/run ownership, rejects conflicting terminal outcomes, and idempotently
records terminal status/time using adapter time. Add `terminal` to
`WorkspaceLifecycleState` and optional `terminal: { status, finishedAt }` to
`WorkspaceInspection`. After a terminal result is persisted, stop/fence run
writers, call finish, then release recovery pins; this starts terminal TTLs.
Interrupted/waiting/retriable failures never call finish. On a later session
resource access or disposal, runtime reconciles owned workspace state against
retained authoritative run/checkpoint records and retries this ordering. A sweep
without proof of terminal publication retains pins; elapsed time is not proof.

The existing workspace policy stays the configuration boundary. Quota gains
`maxSnapshotsPerWorkspace` and `maxRetainedSnapshotBytes`; retention retains the
existing TTL field names. No `defaults.sandboxLifecycle` is introduced.

## CTR-SOWN-OPTIONS

```ts
interface SandboxAdministrationOptions {
  maxCatalogEntries?: number
  selectorRevocationReserve?: number
  maxActiveSandboxes?: number
}
interface WorkspaceAdministrationOptions {
  maxCatalogEntries?: number
  selectorRevocationReserve?: number
}
interface SandboxSnapshotPolicy {
  maxSnapshotsPerOwner?: number // default 32
  maxRetainedSnapshotBytes?: number // default 1073741824, per owner
  maxSnapshotBytes?: number // default 268435456
  unpinnedTtlMs?: number // default 604800000
}
```

All are strict inferred DTOs with positive safe integer fields and defaults from
02-administration. `selectorRevocationReserve + 2` must be less than
`maxCatalogEntries`. Add optional `administration: SandboxAdministrationOptions`
to in-memory, bash, both local-directory sandbox variants, Docker options and
fakeSandbox. In-memory/fake factories gain an optional options object;
autoDetectSandbox internally uses the same defaults. Snapshot fake options add
`snapshots?: SandboxSnapshotPolicy`. Add optional `administration:
WorkspaceAdministrationOptions` to LocalDirectoryWorkspaceOptions. Extend
LocalDurableExecutionOptions with `sandboxAdministration?:
SandboxAdministrationOptions` and `workspaceAdministration?:
WorkspaceAdministrationOptions`, passed to the corresponding factory; existing
`policy` remains its workspace policy. Do not add snapshot options to adapters
without snapshot capability. Built-in sandbox-only adapters accept no workspace
retention/quota fields; the supported workspace policy matrix is 02-administration.
Add `InMemoryDurableWorkspaceOptions { policy?: Partial<DurableWorkspacePolicy>;
administration?: WorkspaceAdministrationOptions }` to the existing in-memory
workspace class constructor/factory. Apply the same supported-field matrix,
defaults, count/pin/retention rules and finite catalog. Its snapshot byte size is
the actual encoded checkpoint payload; it does not claim durable filesystem
recovery or manufacture size estimates for files it does not own.

## CTR-SOWN-ERRORS

Use existing `HarnessError` constructors, serialization, wrapping and cause
normalization. New exported classes follow the existing catalog pattern:

| Class / code / category | Closed metadata | Retriable |
| --- | --- | --- |
| `SandboxPermissionDeniedError` / `SANDBOX_PERMISSION_DENIED` / `permission` | `reason: 'scope_mismatch' \| 'owner_not_authorized' \| 'owner_revoked' \| 'principal_revoked'` | false |
| `SandboxConflictError` / `SANDBOX_CONFLICT` / `sandbox` | `reason: 'binding_changed' \| 'policy_changed' \| 'checkpoint_busy' \| 'snapshot_pinned' \| 'idempotency_conflict'` | only checkpoint_busy |
| `SandboxQuotaExceededError` / `SANDBOX_QUOTA_EXCEEDED` / `sandbox` | `quota: 'catalog_entries' \| 'active_sandboxes' \| 'snapshots' \| 'snapshot_bytes'; limit: number; actual?: number` | false |

Configuration/unsupported policy is `HarnessConfigError`, malformed public
inputs are `ValidationError` (add `where: 'sandbox_options'`), identity/owner
denial uses the new permission error. Keep `SandboxStateLostError` and extend its
closed reason union with `owner_missing`, `scope_terminated`, and
`creation_indeterminate`; it is never a request to create empty state.
Workspace quota uses `WorkspaceQuotaExceededError`; unsafe/missing workspace
references use existing `WorkspaceError` reasons. Provider/transport failures
remain `SandboxError`. Close with incomplete sandbox purge throws
`SandboxError` with `reason: 'cleanup_pending'`, preserving the session.
Timeout/cancellation use the existing operation errors and sandbox/workspace
scope. Callback exceptions become permission denial with a normalized private
cause, not an authorization bypass. Do not put owner IDs, identity, paths,
cursors, payloads, or provider diagnostics in new error metadata/messages.

## Validation and generation

Runtime boundary objects are strict Zod schemas with inferred exported types;
use the existing `HarnessIdentity` schema/type. Function-bearing interfaces and
capability-generics stay handwritten TypeScript because no generator exists for
these local ports. Do not add a code-generation framework to translate these
specs. Compiler declarations and TypeDoc are generated from source; negative
type tests and contract fixtures check their drift. No `any`, open metadata bag,
`as unknown as`, hand-copied PURISTA shape, or unchecked cast is an acceptable
substitute for inference or parsing.
