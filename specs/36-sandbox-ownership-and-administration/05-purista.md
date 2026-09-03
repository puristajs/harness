# PURISTA integration — DEC-SOWN-PURISTA

## Public mapping — CTR-SOWN-PURISTA

Harness is independently useful; these framework policies are not imported into
Harness or its Docker package. Use type-only imports from `@purista/harness`,
never source paths or copied interfaces. The framework keeps its builder naming
and existing adapter precedence.

Replace `AgentSandboxPolicy` with:

```ts
type AgentSandboxPolicy<G extends string = string> = {
  sharing?: SandboxPolicy<NoInfer<G>>
  owner?: AgentSandboxOwnerResolver
}

type AgentSandboxOwnerResolver = (context: {
  identity: AgentRunIdentity
  input: JsonValue
}) => SandboxOwner | undefined | Promise<SandboxOwner | undefined>
```

`setSandboxPolicy<const G extends string = never>(policy:
AgentSandboxPolicy<G>)` infers a literal group from `sharing`; the service
binding validates it against its configured group vocabulary. A runtime-stored
`AgentSandboxPolicy<string>` gets the same strict assembly validation. The resolver receives schema-validated
JSON input and trusted framework identity, not a raw broker envelope; resolving
an owner is not authorization. Harness `options.authorizeOwner` remains required
for explicit borrowing. No callback or adapter is serialized into queue payloads,
public manifests, or telemetry.

`AttachedAgentDefinition.sandboxPolicy?: AgentSandboxPolicy<string>` stores the
executable binding in process. Replace `AgentManifest.sandbox` with the data-only
`AgentSandboxManifest` projection: `{ sharing?: SandboxPolicy<string>;
usesExplicitOwner: boolean }`. It describes only the definition's declared
values and never pretends to contain resolved service configuration.
`usesExplicitOwner` is true exactly when an owner resolver is
configured. No adapter object, callback, owner identity or owner result is in the
projection. Define both types in existing AgentQueueBuilder/types.ts and make
scopedRuntime read the executable field, not the public manifest. Do not mutate
a published manifest in place or create a second runtime-manifest system.

Add optional `ai.sandboxOptions: SandboxBindingOptions<string>` next to existing
`ai.sandbox`. Service composition selects exactly one adapter instance for every
attached Harness runtime: use `ai.sandbox`, otherwise Harness auto-detection.
`ai.sandboxOptions` is the sole PURISTA source for groups, default policy and
external-owner authorization; it is passed whole to the Harness binding and is
not deep-merged with agent declarations. A definition `sharing` maps to its
registered Harness agent/workflow's `sandbox` property, overriding that
definition's embedded policy. Embedded inline definitions retain their own
policies. A missing `sharing` preserves the embedded policy or Harness
inheritance.

An agent cannot select or replace an adapter. This keeps provider choice,
credentials, lifecycle administration and topology at the application/service
boundary while still allowing agents to use shared, private or named-group
partitions of the one configured adapter.

`enabled` is removed, not deprecated. Runtime validation rejects it even from
JavaScript. To disallow command execution, select `inMemorySandbox()` as the
service adapter and
disable undesired built-in tools using the existing tool policy. An absent
adapter is not advertised as sandbox-disabled: Harness requires a filesystem
and may auto-detect bash. No new disabled/no-sandbox port is introduced.

`owner` returns undefined for implicit ownership, or an exact pre-registered
owner for sharing across attached agents/conversations. The mapper calls
`harness.getSession(id, { identity, sandboxOwner })`. `canInvokeAgent` does not
carry the caller's sandbox handle or bypass target authorization; both agents
share only when their configured resolvers return the same authorized owner
and their resolved shared/group partitions match.

## Identity derivation

Resolve optional tenant/principal before deriving any IDs. Hash the versioned
tuple `[v1, serviceName, serviceVersion, agentName, tenantPresent, tenantValue,
principalPresent, principalValue, mode, logicalValue]` with SHA-256. Omitted
values use a presence flag and null tuple slot; no raw identity is emitted.
For ephemeral sessions, logicalValue is transport message ID; for conversation
sessions it is the validated payload-path value. Use prefix `agent-session:`.
Durable run IDs use prefix `agent-run:` and the same identity tuple with mode
`durable` and the configured durable run-key value. Ordinary run IDs remain
Harness-derived from the namespaced session/target/idempotency key; do not
introduce an independent collision-prone framework ID into Harness storage.

Harness name becomes `${serviceName}.${serviceVersion}.${agentName}`. This is
a private integration namespace choice, not a change to declared service/agent
names or queue command names. Shared explicit owner namespaces remain caller-
chosen and independent of that Harness name. Same conversation ID in different
tenants/principals must create different records, not collide and fail validation.

## Ephemeral completion and replay

Add `Session.disposeSandbox(): Promise<void>` to public Harness. For implicit
owners it purges sandbox resources then associated workspaces, preserving
SessionRecord, messages, durable receipts and terminal outputs. For borrowed
owners it only detaches the session's own attachments. This is the narrow compute
lifecycle operation needed by standalone ephemeral users too; it is not a core
maintenance facade or scheduler. `close()` performs it and then deletes the
session record; `release()` remains detach-only.

Persist `SessionSandboxBinding.disposed: boolean`, initially false, set true only
after owned cleanup completes. The adapter barrier is authoritative while a
cleanup retry is pending. A disposed session permits terminal idempotent replay
and history reads, but denies new live invocation with `SandboxStateLostError`;
it cannot allocate empty compute. A new conversation must use a new session
incarnation through explicit close/new creation, not an automatic reset.

For `harnessAgent` and `harnessWorkflow`, pass `identity.transportMessageId` as
the invocation `idempotencyKey` for both prompt and stream. Replay checks the
stored terminal result before touching sandbox registration or compute. Preserve
existing durable run identity and input-conflict checks. Ordinary workflow keys
must now receive the same idempotent run admission as direct agents; they are
currently ignored. Durable terminal runs must replay their saved result before
lease reacquisition, which currently rejects a completed run. This is explicit
work in the replay ticket, not an assumption about existing behavior. Streaming replay uses
existing Harness persisted-result/event behavior and does not fabricate original
model token chunks.

For ephemeral mode, invoke `disposeSandbox` after a terminal Harness result is
persisted, including terminal failure/cancellation. A run in `waiting`,
`interrupted`, active retry, or external-wait suspension only releases attachments.
For `failed`, only a persisted error with `retriable: false` is terminal for
disposal; `retriable: true` retains files and permits retry under the same
idempotency key. Missing retriable metadata is treated as nonterminal until the
existing error normalizer classifies it. Succeeded results and non-retriable
failed/cancelled outcomes replay their saved output/error without resource open.
Same-key kind/target/input mismatch fails before side effects. Use persisted
status plus this classification, not whether the executor returned normally: `onSuspended`
may return an ordinary response. Failed validation/event delivery after a
successful Harness run must not rerun the model; retry reads the same receipt.
Do not delete the receipt merely because compute cleanup succeeded.

Compute cleanup failure must not replace an already-persisted terminal execution
result or original error. Return that result/error, emit only a content-free
cleanup-pending warning, and leave the adapter journal for the next invocation's
cleanup attempt or operator sweep. This is not permission to report purge as
completed. Callback/configuration failure before any resource allocation requires
no purge.

The custom `runFunction` path does not become a new durable/idempotent execution
engine in this sandbox task. It still obeys release/dispose ownership semantics:
validated success attempts disposal before return; every thrown custom-handler
error releases attachments only because this executor has no authoritative queue
terminal-persistence callback. Operator purge/explicit close remains available for
those retained resources. This conservative exception must be documented, not
hidden behind a nonexistent persistence hook. If there is no Harness (no configured models), there
are no sandbox resources to dispose; never invent a fallback adapter for it.
Do not promise exactly-once custom handler execution or event delivery.

Receipt/history retention remains the existing storage/application responsibility
and is explicitly separate from sandbox TTL. These tickets must prove replay
while the existing receipt is retained; they do not add a new global storage-GC
system. Operators must retain receipts through their queue redelivery window;
after expiry the queue must not redeliver, or must reject stale deliveries rather
than assume compute can be reconstructed. This limitation belongs in the runbook.

## Framework error and style rules

Add the private mapper `AgentQueueBuilder/runtime/errors.ts`, using existing
framework `UnhandledError` / `HandledError` and `StatusCode`; there is no existing
Harness mapper to reuse. Do not throw plain
`Error` for new configuration, identity, or owner cases. Preserve the canonical
Harness error code and retriable classification without exposing private causes.
Known HarnessError and existing AgentRunError are mapped to HandledError with a
fixed content-free message and data containing only code/category/retriable.
Preserve those three typed properties on the error for existing queue retry
classification. Configuration/validation maps to StatusCode.BadRequest, denied
owner to Forbidden, conflicts/state loss to Conflict, quota to TooManyRequests,
provider failures/pending cleanup to ServiceUnavailable, timeout/cancellation to
RequestTimeout (retriable remains the original classification). Unknown failures
become UnhandledError(InternalServerError) with no private data/cause copied to
the public error. Already handled framework application errors are unchanged.
External-wait suspension is intercepted before this mapper. No new framework
exception classes or changes to generic queue retry policy are permitted.

Replace sandbox-related `any`/casts in the touched executor/scoped-runtime path
with inferred public Harness builder/definition/session types and a typed private
helper where necessary. Unrelated framework executor redesign is out of scope.
Follow each repository's formatter and naming conventions: Harness camelCase
exports/lowercase module files; PURISTA established builder directories, tabs,
type aliases and type-only imports. Every new public option/method/error has
hover-friendly TSDoc and a short non-obvious sharing/offboarding example.
