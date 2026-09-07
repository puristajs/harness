# Harness Storage Consolidation

Status: approved clean-break implementation specification.

Date: 2026-08-24

This specification replaces the public persistence architecture in
`04-state-queue-stream.md`, `13-public-api.md`, `21-durable-workspaces.md`, and
`22-local-durable-execution.md` wherever those files expose `StateStore`,
`DurableRuntime`, `ContextCheckpointStore`, `DurableExternalWaitAdapter`, or
multiple builder bindings for Harness-owned structured execution data.

There is no compatibility requirement. The affected AI APIs are unreleased.
Legacy names, aliases, forwarding methods, deprecated exports, duplicate
tables, and compatibility shims must be deleted.

## 1. Outcome

An application configures exactly one Harness-owned structured persistence
adapter:

```ts
const storage = sqliteHarnessStorage({ file: '.purista/harness.sqlite' })

const definition = defineHarness({ name: 'support' })
  .addAgent(assistant)
  .addWorkflow(resolveCase)

const runtime = await definition.getInstance({
  model: { provider, model: 'chat-model' },
  storage,
})
```

`HarnessStorage` owns sessions, conversation messages, one authoritative run
record, persisted run events, durable step checkpoints, run/session leases,
and external wait/signal state. These are one transactional consistency
boundary and are never independently configured by an application.

Session creation binds an immutable opaque `SessionRecord.instanceId` and
exact optional identity. `upsertSession(record, 'create' | 'update')` atomically
returns a boolean insertion result. Create never mutates existing records;
update requires the exact active instance and never inserts, so late summary
writes cannot resurrect a closed session. Destructive
`closeSession(id, expectedInstanceId)` is conditional on the same persisted
instance, so stale clients cannot delete a newly recreated conversation. These
are session record semantics, not sandbox lifecycle state. A reacquired durable
run reports `resumed: true` even without a checkpoint; a genuinely first
acquisition remains `false` even when the caller supplies a higher attempt.

## 2. Boundaries

The following concepts remain separate because their semantics, lifecycle, or
backends differ:

| Concept | Owner | Reason |
| --- | --- | --- |
| PURISTA `StateStore` | `@purista/core` | General application/service key-value state used by AI and non-AI code. It is unchanged by this specification. |
| `HarnessStorage` | `@purista/harness` | Harness conversations and recoverable execution state. |
| `MemoryEngine` | `@purista/harness` | Optional database extension point for application/tenant/principal/session/run/agent recall. Core owns the `MemoryAdapter` orchestration result, TTL, scoping, search fusion, model routing, and validation defined by spec 33. |
| `Sandbox` | `@purista/harness` | Active filesystem and process lifecycle. |
| `DurableWorkspace` | `@purista/harness` | Optional durable file snapshots, quotas, retention, and encryption metadata. |
| Review/domain records | Application service | Authorization, reviewer identity, evidence, revisions, expiry, and business invariants. |

Distributed sandbox generations, leases, fencing tokens, provider references,
retention, and cleanup queues are also outside `HarnessStorage`. An adapter
owns any required coordination behind the public Sandbox port. Harness and
PURISTA do not inspect sandbox topology, and Harness storage implementations do
not add lifecycle methods for spec 34.

The PURISTA `StateStore` MUST NOT be expanded with Harness operations and MUST
NOT be automatically adapted to `HarnessStorage`. Its `getState`, `setState`,
and `removeState` contract does not promise the append ordering, transactions,
leases, compare-and-set, range queries, or idempotent signals required by
Harness execution. A deployment may use the same physical database for both
contracts through separate adapters.

## 3. Public configuration

Runtime storage is supplied only when the immutable definition becomes an
instance. The field is required when the compiled graph needs durability and is
an optional replacement for the process-local default otherwise:

```ts
interface HarnessInstanceConfig {
  storage?: HarnessStorage
  memory?: MemoryEngine
  // sandbox and workspace appear only when the compiled graph requires them.
}
```

The default is `inMemoryHarnessStorage()`. It is process-local and suitable for
tests and development. It does not advertise persistence or multi-instance
coordination.

Definitions never register storage, memory, sandbox, or workspace adapters.
Their declarative fields compile requirements; `getInstance(...)` validates the
exact runtime bindings atomically before starting resources. Omitted memory
creates `inMemoryMemoryEngine()` when the graph's memory needs allow it.
`HarnessInspection` reports one `storage`
adapter and, when present, separate `memory`, `sandbox`, and `workspace`
adapters. It does not report storage's
internal execution/wait facets as independently configured adapters.

## 4. Storage contract

The supported application-facing type is `HarnessStorage`. Internal operation
groups may be split into focused source files, but the application receives and
passes one object. The adapter guarantees one consistency boundary across its
run lifecycle operations.

The contract covers:

1. Session create/read/update/delete.
2. Ordered message append/list/replace/delete.
3. One run create/read/list/transition model.
4. Ordered event append/list.
5. Durable run acquisition, lease release, and attempt tracking.
6. Durable step checkpoint read/commit, fenced replacement, and terminal
   deletion.
7. External wait registration/read/signal/cancel bound to a run and session.
8. Idempotent close and Harness adapter-context configuration.

Every implementation MUST pass `harnessStorageContract` from
`@purista/harness/testing`. There are no partial conversation-only storage
adapters. Differences between in-memory, local persistent, and distributed
implementations are guarantees represented by storage capabilities, not
missing methods.

The v4 leased-run mutation surface adds exactly these operations to
`HarnessStorage`; they remain part of the same adapter and transaction domain:

```ts
interface CreateRunRequest {
  readonly id: string
  readonly sessionId: string
  readonly kind: 'agent' | 'workflow' | 'child_task'
  readonly target: string
  readonly startedAt: string
  readonly input: JsonValue
  readonly metadata?: Readonly<Record<string, JsonValue>>
}

type RunAcquisitionMode = 'initial' | 'resume'

interface RunAcquisitionCheckpointExpectation {
  readonly stepId: string
  readonly sequence: number | null
}

interface RunAcquisitionExpectation {
  readonly revision: number
  readonly status: 'running' | 'waiting' | 'interrupted'
  readonly checkpoint: RunAcquisitionCheckpointExpectation
}

interface AcquireRunRequest {
  readonly mode: RunAcquisitionMode
  readonly runId: string
  readonly sessionId: string
  readonly workerId: string
  readonly acquisitionId: string
  readonly expected: RunAcquisitionExpectation
  readonly requestedAttempt?: number
}

interface DurableRunLease {
  readonly runId: string
  readonly sessionId: string
  readonly workerId: string
  readonly acquisitionId: string
  readonly leaseId: string
  readonly attempt: number
  readonly resumed: boolean
  readonly acquiredFrom: RunAcquisitionExpectation
  readonly run: RunRecord
  readonly checkpoint?: RunCheckpoint
  readonly checkpoints: readonly RunCheckpoint[]
  release(): Promise<void>
}

interface ReplaceCheckpointRequest {
  readonly runId: string
  readonly sessionId: string
  readonly stepId: string
  readonly expectedSequence: number
  readonly leaseId: string
  readonly workerId: string
  readonly replacement: RunCheckpoint
}

interface AppliedApprovalDecisionV1 {
  readonly approvalId: string
  readonly approved: boolean
}

interface ApprovalResumeReceiptV1 {
  readonly schemaVersion: 1
  readonly interruptId: string
  readonly resumeEventId: string
  readonly decisions: readonly AppliedApprovalDecisionV1[]
  readonly deploymentRevision: string
  readonly compiledGraphDigest: string
  readonly sessionIdentityDigest: string
  readonly rootTarget: Readonly<{
    kind: 'agent' | 'workflow'
    id: string
  }>
}

type TerminalApprovalReceiptV1 = ApprovalResumeReceiptV1

type FinalizeRunPatch =
  | Readonly<{
      status: 'succeeded'
      finishedAt: string
      output: JsonValue
      error?: never
      approvalReceipt?: TerminalApprovalReceiptV1
    }>
  | Readonly<{
      status: 'failed' | 'cancelled'
      finishedAt: string
      output?: never
      error: SerializedError
      approvalReceipt?: TerminalApprovalReceiptV1
    }>

interface FinalizeRunRequest {
  readonly runId: string
  readonly sessionId: string
  readonly leaseId: string
  readonly workerId: string
  readonly patch: FinalizeRunPatch
  readonly terminalEvent: PersistedFinalRunEvent
  readonly checkpointDisposition: 'delete-all'
}

interface HarnessStorage {
  createRun(request: CreateRunRequest): Promise<RunRecord>
  acquireRun(request: AcquireRunRequest): Promise<DurableRunLease>
  replaceCheckpoint(request: ReplaceCheckpointRequest): Promise<void>
  finalizeRun(request: FinalizeRunRequest): Promise<void>
}
```

`CreateRunRequest` is strict and contains exactly the caller-owned immutable
creation fields shown above. It excludes `revision`, `status`, `finishedAt`,
`output`, `error`, `approvalReceipt`, `attempt`, `workerId`, `initialStepId`,
lease identity, and every other storage-authored field. `id`, `sessionId`,
`kind`, `target`, and `startedAt` use their existing validators;
`startedAt` is ISO 8601 UTC. `input` must be canonicalizable JSON. `metadata`,
when present, is a plain JSON object whose full nested value is immutable; its
absence is distinct from an explicitly supplied empty object. Unknown keys,
undefined values, non-JSON prototypes, and non-finite values are rejected before
storage mutation with the same fixed
`StateError{op:'createRun',reason:'run_conflict'}` contract below.

`createRun` atomically creates
`{...request,status:'running',revision:1}` and returns a recursively frozen
authoritative `RunRecord`. Storage canonicalizes and copies `input` and
`metadata`; it never retains a caller-mutable object. The immutable creation
identity is the canonical tuple
`['harness-run-create-v1',id,sessionId,kind,target,startedAt,input,
metadata-is-present,metadata ?? null]`. JSON values use spec 42's canonical
encoder, so object-key insertion order is irrelevant and array order remains
significant.

When `id` already exists, storage compares that tuple against the immutable
creation fields retained on the current record. A byte-equivalent retry returns
the current recursively frozen authoritative record exactly as it now exists,
including a later revision/status/attempt or terminal result, without changing
any record, event, message, checkpoint, wait, or lease. A mismatch rejects with
fixed message `Run creation conflicts with an existing logical run.` and exact
metadata `StateError{op:'createRun',reason:'run_conflict'}`. Comparison
precedence is request shape/identifier validation, then existing-record
`sessionId`, `kind`, `target`, `startedAt`, canonical input bytes, metadata
presence, and canonical metadata bytes. The run id is the lookup key and the
first member of the identity tuple. Errors never expose the differing field,
input, metadata, canonical bytes, target content, or stored record.

These rules apply identically to `agent`, `workflow`, and `child_task` records.
For a caller-owned durable `runId`, Harness checks or creates this record before
building an acquisition request. Reusing that run id with different agent or
workflow input, target, session, or immutable metadata fails at `createRun`
before `acquireRun`, even when the existing run remains non-terminal. Child-task
creation uses its spec 28 canonical input and immutable descriptor/lineage
metadata through the same fence.

`AcquireRunRequest` replaces `DurableRunStart` as the sole `acquireRun` input,
and the lease has exactly the result fields above; the former duplicated
`lease.start` payload is removed. Immutable target/session/input metadata lives
only on the authoritative `RunRecord` created before acquisition.

`RunRecord.revision` is a positive safe integer. The creation winner receives
revision `1`; an exact create retry returns the current revision. A successful
acquisition, checkpoint commit or replacement, resumable release or wait
transition, and terminal mutation each increment it by exactly one in the same
transaction as that mutation. Message and event append operations do not
change it. This revision is the storage-owned acquisition CAS token and is not
a deployment, schema, definition, or graph version.

Before acquisition, Harness reads the authoritative `RunRecord` and the
checkpoint named by `expected.checkpoint.stepId`. It copies the record's exact
`revision` and `status`, and uses that checkpoint's sequence or `null` when the
step is absent. `AcquireRunRequest` and all nested objects are strict. The
revision and a present checkpoint sequence are positive safe integers;
`requestedAttempt`, when present, is a positive safe integer. Identifiers use
their existing closed grammars. Harness derives `acquisitionId` exactly as
`acq_` plus lowercase SHA-256 of the canonical JSON tuple
`['harness-run-acquisition-v1',mode,runId,sessionId,workerId,
expected.revision,expected.status,expected.checkpoint.stepId,
expected.checkpoint.sequence,requestedAttempt ?? null]`. Applications and
adapters never choose or reinterpret it.

`mode:'initial'` requires the pristine created record: revision `1`, status
`running`, no stored attempt or worker, no active or historical acquisition,
and no checkpoint for any step. Its checkpoint expectation therefore has
`sequence:null`. `mode:'resume'` requires a previously acquired non-terminal
record; it may be `running` after process loss, `waiting`, or `interrupted`, and
the selected checkpoint may be present or absent. A terminal record is never
acquired. `resumed` is exactly `mode === 'resume'`, including a recovery with
no checkpoint; it remains false for an initial acquisition with a caller
requested attempt greater than one. The acquired attempt is
`max(previousAttempt + 1, requestedAttempt ?? 1)`, treating an absent previous
attempt as zero. Acquisition atomically changes the record to `running`, stores
that attempt and worker, sets `initialStepId` from
`expected.checkpoint.stepId` only for the initial acquisition (resume retains
the stored value), increments its revision, and installs the exclusive
run/session lease.

Within that transaction, storage compares the exact record revision/status and
the named checkpoint step/sequence before mutating anything. It then returns
the newly revised `run`, the selected checkpoint when present, and every
checkpoint as one immutable ascending-sequence snapshot under the installed
lease. `acquiredFrom` is the exact frozen expectation. H4-008 compares the
returned record/checkpoint bytes with its optimistic values; no second
unfenced read is used as proof of ownership.

An unexpired lease stores the exact acquisition id, canonical request bytes,
and acquired record revision. Repeating the byte-equivalent request while the
record still has that acquired revision and the expected checkpoint is
unchanged returns the same lease id, attempt, revision, record, and checkpoint
snapshots without extending expiry or incrementing anything. This is the
response-loss idempotency window before the lease holder's first fenced
mutation. If that logical attempt has already advanced its record or selected
checkpoint, the retry fails closed as `acquisition_conflict`; it never joins,
restarts, releases, or rewinds the active execution. Reusing an acquisition id
with different bytes, or any record/checkpoint expectation mismatch, fails before mutation with
`StateError{op:'acquireRun',reason:'acquisition_conflict'}`. Another unexpired
run or session lease fails with
`StateError{op:'acquireRun',reason:'lease_conflict'}`. A missing run is
`StateError{op:'acquireRun',reason:'run_not_found'}`; a terminal record uses the
canonical terminal-run error. After expiry, a caller must reread and create the
new deterministic acquisition id from the current revision; an old request
cannot reacquire.

Validation order is strict request shape and identifier grammar; run existence
and session identity; terminal status; same-acquisition exact-retry handling;
record revision/status/mode and checkpoint expectation; then competing run or
session lease availability. The first applicable failure wins and no failure
changes record, checkpoint, or lease state.

`release()` is fenced by `(runId,sessionId,workerId,leaseId,acquisitionId)`.
While that exact lease is active it atomically marks a still-running record
`interrupted`, increments revision once, and removes both run and session
lease rows. Repeating the same release is a no-op. A stale release after
another acquisition cannot mutate or release the newer owner. Checkpoint,
wait, replacement, and finalization writes remain fenced by the active lease
and fail without mutation when its identity is stale.

Both `FinalizeRunPatch` variants and their nested values are strict and reject
unknown keys. `finishedAt` is valid ISO 8601 UTC. The authoritative v4
`RunRecord` adds exactly
`readonly approvalReceipt?: TerminalApprovalReceiptV1` to its existing fields;
it is absent on every non-terminal record and on a terminal record that did not
consume an approval resume. Storage readers validate that field together with
the status/output/error discriminant before returning a record.
`RunRecord.input` is required for `kind:'agent'|'workflow'` and is the exact
canonical pre-transform JSON wire input; it never stores the schema-transformed
value. The existing spec 28 `child_task` input remains required as its canonical
child-call input, but `approvalReceipt` is forbidden for `kind:'child_task'`.
The terminal receipt intentionally references root input by residing on
the same immutable run record rather than duplicating content or a second
digest. Its `rootTarget` must equal the record's `(kind,target)`.

`replaceCheckpoint` requires the active unexpired lease and the exact existing
`(runId,sessionId,stepId,expectedSequence)`. The replacement keeps that run,
session, step, lease, worker, attempt, and root input and uses
`sequence > expectedSequence`; the runtime supplies the next global checkpoint
sequence for the run. It atomically removes the old value and
installs the replacement. Retrying the already installed byte-equivalent
replacement succeeds. Any other observed checkpoint, sequence, owner, or
replacement is `StateError{op:'replaceCheckpoint',reason:'checkpoint_conflict'}`
without exposing checkpoint data.

`finalizeRun` is the sole terminal operation for an acquired run. In one
transaction it verifies the active lease, writes the terminal run patch,
validates and appends the matching terminal `run.finished` event, deletes every
checkpoint owned by that run, removes the lease, and commits. `terminalEvent`
uses spec 12's exact strict `PersistedFinalRunEvent`. Its envelope must use the
request run id, `patch.finishedAt`, the next unused sequence, and the
deterministic event id from spec 42. A `succeeded` patch maps to the exact
content-free payload `{outcome:{status:'completed'}}`; its output is forbidden
from the event payload and is stored only as the authoritative terminal
`RunRecord.output`. A `failed` or `cancelled` patch maps to the same status and a
canonically equal sanitized `SerializedError`. Parent correlation is either
absent or the exact paired correlation defined by spec 12. Every other payload
key, including `runId`, `output`, or `interrupt`, is forbidden. A mismatch is
`StateError{op:'finalizeRun',reason:'event_conflict'}` and changes nothing.
The atomic record/event commit is the coherence boundary: success coherence
comes from writing the patch output once with its matching content-free status
event, while failure and cancellation additionally compare the canonical error.
An exact retry against the already stored terminal record compares the complete
patch, including output or error, then independently compares the stored event
with this privacy-safe projection. It succeeds without mutation; a different
terminal patch or receipt is
`StateError{op:'finalizeRun',reason:'run_conflict'}`; an exact retry includes the
same terminal event and succeeds without appending it twice. A failed
transaction changes none of those records. `finishRun` remains the terminal
operation only for an ordinary run that never acquired a durable lease; using
it while a run lease exists is
`StateError{op:'finishRun',reason:'active_lease_requires_finalize'}`.

`TerminalApprovalReceiptV1` is present only when this terminal attempt resumed
a tool-approval interruption. The `decisions` array is sorted bytewise by
`approvalId`, contains each approval id exactly once, and stores only the
boolean decision. The receipt and every nested object are strict: unknown
keys, duplicate ids, invalid identifiers, another schema version, unsorted
rows, a malformed lowercase `sha256:` digest, an empty deployment revision, a
root-target mismatch, or a non-boolean decision fail validation before the transaction. It
never stores reviewer reason text, identity, input, output, arguments, prompts,
messages, credentials, provider state, or arbitrary metadata. `RunRecord`
exposes the receipt only through its optional exact `approvalReceipt` field;
there is no receipt table or checkpoint copy after terminalization.

The receipt is part of the terminal patch's byte-equivalence test. After
checkpoint deletion or process restart, the same `(resumeEventId, normalized
decisions)` returns the already committed terminal result from the authoritative
`RunRecord` without reopening execution. Reusing that `resumeEventId` with a
different normalized decision set is `ApprovalResumeError{reason:'event_conflict'}`.
Any new event id for the consumed interrupt is
`ApprovalResumeError{reason:'stale_continuation'}`. Failed and cancelled runs
reconstruct only their canonical local terminal error contract; the receipt
does not make transported errors trusted. An exact `finalizeRun` retry includes
the byte-equivalent receipt and succeeds idempotently.

`appendEvents` receives records with positive safe-integer `sequence` and the
deterministic event id defined by spec 42. For one run it atomically accepts a
contiguous batch beginning at the next unused sequence. A byte-equivalent
record at an already stored sequence/id is an idempotent retry. Changed reuse
of an id or sequence is `event_conflict`; a new gap or non-increasing member is
`event_sequence_conflict`. Validation applies to the whole batch before any
new event is written. `listEvents` returns ascending sequence order and its
`after` cursor is the last returned `eventId`.

## 5. One run model

`RunRecord` is the sole run source of truth. It contains ordinary run metadata
and durable attempt/lifecycle metadata. A storage backend MUST NOT create a
second durable-run record or table.

Statuses are:

- `running`: an attempt owns or is acquiring execution;
- `waiting`: execution is safely suspended for an external signal;
- `interrupted`: a durable attempt stopped and the same run may resume;
- `succeeded`: terminal success;
- `failed`: terminal failure;
- `cancelled`: terminal cancellation.

Only `waiting` and `interrupted` may resume. `succeeded`, `failed`, and
`cancelled` reject acquisition. An observed execution failure terminalizes as
`failed` and observed cancellation terminalizes as `cancelled`, for both
durable-target and approval-recovery leases. Only a typed Harness interruption
or registered external wait deliberately releases a resumable record. Process
loss before a terminal or interruption commit leaves the run lease-owned
`running`; after lease expiry, acquisition resumes from its latest checkpoint.

Run transitions, lease changes, and associated wait registration MUST be
transactional when they are part of one operation. There are two deliberately
disjoint terminal mutations: ordinary unleased runs use the existing
`FinishRunPatch` with `finishRun`, while acquired runs use the strict
`FinalizeRunPatch` with the fenced atomic `finalizeRun` operation above. Only
the latter may carry `TerminalApprovalReceiptV1`; there are no overloads or
alternative approval receipt representations.

## 6. Durable steps and waits

`ctx.step(...)` remains the public durable replay primitive. Its checkpoints
are storage-owned implementation records linked to the authoritative run.

`ctx.externalWait.wait(...)` remains the public provider-neutral suspension
primitive. Application code supplies only:

```ts
{
  waitId: string
  kind: string
  schemaVersion: string
  definitionVersion: string
  deadline: string
}
```

The Harness adds `runId` and `sessionId` before storage. Registering a new wait
atomically marks the run `waiting` and releases its lease. Signalling is
idempotent by `(waitId, eventId)`. A terminal signal does not itself execute
application code; the application enqueues or invokes the same logical run.

Storage operations for waits are not independently injectable. Public signal
operations are available through the configured Harness storage handle or a
small Harness-owned signalling facade returned by the application composition
root; they are not a second adapter.

## 7. Context checkpoint removal

The following are removed:

- `ContextCheckpoint`
- `ContextCheckpointRef`
- `ContextCheckpointQuery`
- `ContextCheckpointStore`
- `ContextCheckpointStoreInfo`
- `ContextCheckpoints`
- `ctx.checkpoints`
- `.checkpoints(...)`
- `harness_context_checkpoints`
- all `context_checkpoint.*` capabilities, spans, metrics, docs, and factories

Use the existing primitive that matches the requirement:

- deterministic replay output: `ctx.step(...)`;
- mutable session/user/tenant recall: `ctx.memory`;
- conversation context: session history;
- business handoff/evidence: application state and typed PURISTA commands.

The Harness does not prescribe application vocabulary such as `summary`,
`handoff`, or `goal_state`.

## 8. Workspace and local execution

The durable workspace port is `DurableWorkspace`. An agent or workflow opts in
with `workspace: true`, and instance creation supplies `workspace`. It remains
separate from structured storage because
it manages files, snapshots, byte quotas, cleanup, retention, and encryption
metadata.

The local bundle is:

```ts
interface LocalDurableExecution {
  storage: HarnessStorage
  sandbox: LocalDurableSandbox
  workspace: DurableWorkspace
  close(): Promise<void>
}
```

The only primary local storage exports are:

- `InMemoryHarnessStorage`
- `inMemoryHarnessStorage`
- `SqliteHarnessStorage`
- `sqliteHarnessStorage`
- `localDurableExecution`
- `LocalDirectoryWorkspace`
- `localDirectoryWorkspace`
- `localDirectorySandbox`

Delete all legacy state/runtime/checkpoint/wait factories and aliases. The
SQLite schema contains `harness_sessions`, `harness_messages`, `harness_runs`,
`harness_run_events`, `harness_run_checkpoints`, `harness_run_leases`,
`harness_external_waits`, and `harness_external_wait_signals`. It does not
contain `harness_durable_runs` or `harness_context_checkpoints`.

SQLite is local/single-host only. It advertises persistence but not
multi-instance coordination. In-memory storage advertises neither. A future
production adapter must pass the same contract suite and advertise its exact
distributed guarantees.

## 9. PURISTA integration

PURISTA keeps its unrelated top-level `stateStore` runtime option unchanged.
A service mounts one immutable Harness definition with
`ServiceBuilder.mountHarness(...)`; its `getInstance(...)` `ai.storage`,
`ai.memory`, `ai.sandbox`, and `ai.workspace` fields bind the exact compiled
Harness requirements. The host supplies logger and telemetry through the
integrator bindings rather than accepting them as user `ai` fields.

Durability is declared by `durable: true` on an agent or workflow definition;
`workspace: true` additionally requires durable workspace support. A queue
binding supplies a stable delivery identity through the ordinary typed Harness
invocation options. Queue retries and approval continuation reuse that same
resolved session, run, and invocation identity. Startup fails when the compiled
storage or workspace requirements are absent or incompatible. Runtime bindings
never grant an undeclared capability.

PURISTA review/domain records remain ordinary application state and commands.
They are never stored in `HarnessStorage` except for the bounded opaque wait
reference.

One PURISTA service instance constructs one shared Harness runtime for its
mounted root agents and workflows plus their private dependency closure.
Runtime adapters are supplied once and the service shuts that Harness down
once. Public model aliases and defaults remain definition concepts; private
service runtime indexes prevent collisions without exposing lookup APIs or
changing Framework event vocabulary.

## 10. Observability

Existing model/tool/guardrail semantic-convention spans and token accounting
remain unchanged. Storage operations emit content-free short spans and metrics
under `harness.storage.*` with operation, adapter id, persistence scope, run
status, attempt, and safe correlation identifiers. They never include prompts,
messages, inputs, outputs, checkpoint payloads, wait content, reviewer identity,
file paths, or credentials.

Expected enforcement decisions and waiting transitions do not mark spans as
errors. Storage failures do. No span remains open while a workflow waits for a
human or external system.

Remove `harness.runtime.*` and `harness.context_checkpoint.*` storage operation
names after their `harness.storage.*` replacements are tested and documented.

## 11. Testing and drift gates

Implementation is incomplete until all of the following pass:

1. Public API/type tests prove conditional `getInstance(...)` storage/workspace
   bindings and reject runtime adapters that the compiled graph does not permit.
2. `harnessStorageContract` passes for in-memory and SQLite implementations.
   It proves strict create requests for all three run kinds, rejection of every
   storage-authored request field, revision-one running frozen returns, exact
   retry returning the current authoritative record, deterministic content-free
   conflict precedence, and repeated durable agent/workflow input mismatch
   before acquisition. It also proves initial and resume acquisition from exact optimistic record
   revision/status and checkpoint step/sequence; deterministic acquisition-id
   response-loss replay; changed-id/request, stale revision/checkpoint, and
   competing-lease rejection; expiry takeover and stale-release fencing; strict
   terminal approval-receipt validation; atomic receipt plus
   terminal patch plus terminal event plus checkpoint deletion plus lease
   release, exact retry, byte-different receipt conflict, required canonical
   root input, and receipt revision/graph/session/root-target validation.
3. SQLite rebuild tests prove history, one run record, attempt increments,
   checkpoint replay, wait suspension/signal/resume, lease takeover, and
   idempotent close.
4. Schema inspection proves forbidden legacy tables are not created.
5. Failure tests prove durable errors become resumable `interrupted` runs and
   terminal statuses cannot resume.
6. PURISTA tests prove top-level `stateStore` remains unchanged, `ai.storage`
   wiring works, stable payload-derived run ids survive new queue job ids, and
   missing required capabilities fail startup.
7. Examples compile and exercise standalone and PURISTA durable review paths.
8. Harness docs, README, package inventory, public website, Handbook, and
   canonical skills use only the new names and explain the four data concepts.
9. Repository-wide searches contain no legacy public identifiers except this
   specification's explicit removal lists and historical migration evidence.
10. Harness/PURISTA builds, type tests, unit/integration tests, documentation
    link checks, `audit:skills`, and `audit:knowledge` pass.

## 12. Release

This is an unreleased clean break. No runtime compatibility migration, alias,
or deprecation period is provided. Development SQLite databases from the old
branch schema are disposable; the new adapter rejects an incompatible schema
version with a safe remediation telling the developer to recreate the local
database. Production data migration is not applicable because SQLite is not a
supported production multi-instance backend and the affected API has not been
released.

## Approved decision-boundary alignment

Wait requests, signals and snapshots have strict schema-derived closed shapes.
Workflow wait returns ExternalWaitResolved, while storage retains the
waiting/terminal union. Application review records, reviewer identity, business
claims, and comments remain outside HarnessStorage. The sole runtime receipt is
the strict content-free `TerminalApprovalReceiptV1` attached atomically to a
terminal `RunRecord`. Exact authority: [approved decision-boundary contracts](./37-decision-boundaries/03-contracts/decisions.md).
