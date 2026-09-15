# Streaming

**Purpose.** Defines ordering guarantees, bounded live observation, and the
privacy-safe persisted envelope for the canonical v4 `ExecutionEvent` union.
Streaming is internal to the harness: there is no pluggable stream adapter.

## Portable and persisted events

The exact portable `ExecutionEvent` discriminated union and its common
`eventId`, `sequence`, `runId`, `parentRunId?`, and `parentInvocationId?`
correlation are owned by
[spec 42 section 2](./42-composable-definitions-and-catalogs.md#2-shared-definition-contracts).
This specification owns ordering, bounded live observation, and privacy-safe
persistence and does not define a second event union.

The persisted envelope is exact:

```ts
interface PersistedRunEvent {
  readonly id: string
  readonly sequence: number
  readonly runId: string
  readonly at: string
  readonly type: HarnessExecutionEventType
  readonly payload: JsonValue
}

type PersistedEventParentCorrelation =
  | Readonly<{
      readonly parentRunId?: never
      readonly parentInvocationId?: never
    }>
  | Readonly<{
      readonly parentRunId: string
      readonly parentInvocationId: string
    }>

type PersistedRunFinishedPayload = PersistedEventParentCorrelation & (
  | Readonly<{ readonly outcome: Readonly<{ readonly status: 'completed' }> }>
  | Readonly<{ readonly outcome: Readonly<{ readonly status: 'interrupted' }> }>
  | Readonly<{
      readonly outcome: Readonly<{
        readonly status: 'failed' | 'cancelled'
        readonly error: SerializedError
      }>
    }>
)

type PersistedFinalRunFinishedPayload = Exclude<
  PersistedRunFinishedPayload,
  PersistedEventParentCorrelation &
    Readonly<{ readonly outcome: Readonly<{ readonly status: 'interrupted' }> }>
>

type PersistedFinalRunEvent = Omit<PersistedRunEvent, 'type' | 'payload'> &
  Readonly<{
    readonly type: 'run.finished'
    readonly payload: PersistedFinalRunFinishedPayload
  }>
```

`id` equals the portable event's `eventId`; the other envelope fields equal the
corresponding portable event fields. `payload` is the privacy-safe projection
after removing `eventId`, `sequence`, `runId`, `at`, and `type`. The canonical
`SerializedError` from spec 15 is used wherever an error is exposed in an event,
run record, or checkpoint.

Every `PersistedRunFinishedPayload` object and nested object is strict and
rejects unknown keys. The parent fields are both absent for a root event and
both present with their exact portable values for a relayed nested event. The
payload never contains `runId`, `output`, `interrupt`, or other application
content. Successful output remains only on the authoritative terminal
`RunRecord`; a failed or cancelled payload retains only its canonical sanitized
`SerializedError`. `PersistedFinalRunEvent` excludes the non-terminal
`interrupted` projection and is the exact event accepted by `finalizeRun`.

`at` is ISO 8601 UTC. `callId` is `tc_<ulid>` for tool calls and `sk_<ulid>` for skill calls; the same id appears in `started` and `finished`. `delegationCallId` is `delegate_<ulid>` for workflow-local child-agent calls and appears on the matching `agent.started` / `agent.finished` pair.

Fan-out and child-task lifecycle events are content-free operational metadata.
Child task events belong to the child task's own run stream, not the parent
workflow stream. See [28-workflow-child-tasks](./28-workflow-child-tasks.md).

`text(...)` and `object(...)` are final request-response model calls and emit no
partial output event. A default agent loop emits `output.text.delta` or
`output.object.snapshot` according to its exact target update contract. A
direct workflow `textStream(...)` emits `model.output.text.delta`, and a direct
workflow `objectStream(...)` emits `model.output.object.snapshot`. These two
workflow-only families are model activity on the workflow's existing run:
each carries `{kind:'workflow',workflowId}`, the required managed `callId`,
`modelAlias`, and the stable stream id in `id`. They are neither workflow target
updates nor synthetic child-run events.

Every successfully completed generative call emits one `model.completed` with
the same exact caller correlation; a workflow call always includes `callId`.
Successful embedding and reranking calls emit their corresponding completion
events with the same correlation. These rules are automatic and have no public
`emitRunEvents` switch. The enclosing session supplies caller and run identity;
workflow code cannot relabel them. UI labels and protocol names remain in the
application integration layer.

The harness does NOT auto-emit log-style events from logger calls; there is no `'log'` variant in `ExecutionEvent`. Loggers and run events are independent surfaces.

## Streaming API

```ts
const stream: HarnessTargetStream<typeof workflow> =
  session.workflows.ingestKnowledge.stream(input, options)

for await (const event of stream) {
  // observe exact root and nested events
}

const terminal = await stream.result
// On an early consumer disconnect:
// await stream.cancel('consumer disconnected')
```

Each `run`/`stream` invocation drives one event producer. `stream()` returns an
exact `HarnessTargetStream<Target>` over an in-process bounded queue scoped to
that run. Its `result` independently resolves the canonical completed,
interrupted, failed, or cancelled terminal outcome carried by the direct root
`run.finished`; only failure before a trustworthy terminal rejects it. Its
idempotent `cancel(reason?)` requests execution cancellation. Consumer
slowness MUST NOT pause model/tool/workflow execution. Persistence of events
for audit goes through `HarnessStorage.appendEvents`. There is no pluggable
stream adapter and no `Stream` port.

- The first event is always `run.started` (with `runId` matching the iterator's run).
- The last event is always `run.finished`.
- After `run.finished` is yielded, the iterator returns `{done: true}`.
- If the consumer breaks early, the run continues. It cancels only through
  `stream.cancel(reason?)` or the invocation's `options.signal`.
- Cancellation yields one `run.finished` whose `outcome.status` is
  `cancelled`, resolves `stream.result` with that same exact terminal, and then
  ends.
- The aggregate `run(...)` variant still drives the same lifecycle internally;
  events are appended and persisted, but no consumer reads them.

For an approval resume through `.stream(...)`, the first iterator item is the
original privacy-safe `run.started` loaded from persisted sequence `1`. Harness
does not append it again, deliver it to other live subscribers, increment the
checkpoint's `nextEventSequence`, or allocate another event id. New resume
events then begin at the checkpoint's existing `nextEventSequence`; intermediate
events from the prior attempt are not replayed. If terminal-receipt validation
selects an already committed outcome, Harness strictly validates the terminal
`RunRecord` and both persisted event envelopes. It reconstructs the portable
`run.started`, then reconstructs the portable `run.finished` from the terminal
event's identity, sequence, timestamp, and parent correlation plus the
authoritative record's output or error. It yields those two reconstructed events
and ends, with no write or live emission. A persisted payload is never cast or
returned as an `ExecutionEvent`. A missing, duplicate, malformed, or
non-sequence-one persisted start fails before lease acquisition or effects with
`StateError{op:'listEvents',reason:'event_sequence_conflict'}`.

## Ordering guarantees

0. Event sequence starts at one for each run and is contiguous through the one
   terminal event. An exact persisted retry keeps the same event id and
   sequence; storage never allocates either value.
1. Per-run total order: events for a given `runId` are yielded in the order they are produced.
2. `run.started` precedes every other event for the run.
3. `run.finished` succeeds every other event for the run.
4. For each started tool call, `tool.started` precedes `tool.finished` with the same caller and `callId`. A denied or rejected agent-selected call may finish without starting because no side effect began. Tool events for different call ids may interleave.
5. For each agent call, `agent.started` precedes `agent.finished`.
6. `output.text.delta` and `model.output.text.delta` events for one `id` are yielded in provider chunk order.
7. `output.object.snapshot` and `model.output.object.snapshot` events for one `id` are yielded in provider chunk order. Each snapshot replaces the prior provisional value for that stream.
8. The corresponding `model.completed` follows successful provider stream completion and carries the same stream id and caller; for a direct workflow model call it also carries the same required `callId`.
9. When governance exposure is configured, `policy.exposure` events may precede an agent model call and never include tool input or output. When execution governance is configured, `policy.evaluated` and approval events for an agent-selected tool call precede `tool.started`.

No ordering is guaranteed *across* runs (only within a run).

## Bounded Live Observation

The run queue is bounded. Consumer slowness does not pause the producer:

- The harness buffers live events up to an implementation-defined limit.
- On overflow, the harness drops oldest non-terminal live events and emits a sanitized `stream.overflow` event with a dropped count.
- Persisted audit events remain authoritative and are not dropped because a live consumer is slow.

Implications:

- A slow UI consumer may miss non-terminal live events under overflow.
- Terminal run state is persisted via `HarnessStorage`; consumers needing full history must call `storage.listEvents(runId)`.

## Subscriber failures

If an internal live-delivery subscriber callback rejects, Harness removes that
subscription, logs `warn` with
`harness.error.code='STREAM_SUBSCRIBER_FAILED'`, and continues the run. Other
consumers are unaffected. An exception thrown by application code inside its own
`for await` body is outside Harness and merely stops that consumer unless it
also calls `stream.cancel()`. `STREAM_SUBSCRIBER_FAILED` is a log code, not an
error class.

## Privacy-safe persisted event payloads

Persisted event payloads are sanitized by default. `runId`, `at`, and `type` are stored as `PersistedRunEvent` fields and are not duplicated inside `payload`.

When `telemetry.contentCaptureMode` is `NO_CONTENT` or omitted, prompts, model outputs, structured object payloads, tool inputs/results, memory, files, and user data MUST NOT be stored in persisted event payloads. Payloads may include operational metadata such as ids, status, counts, dimensions, `topN`, usage, stream source metadata (`streamId`, `modelAlias`, `callId`, and the exact `caller` union), child-agent lineage metadata (`delegationCallId`, `delegationDepth`, `parentAgentId`), and serialized harness errors.

Governance/approval events contain only the closed evidence, occurrence and terminal fields in [decision contracts](./37-decision-boundaries/03-contracts/decisions.md). They exclude raw input/output, free-form reasons, reviewer identity and arbitrary metadata in every capture mode.

When `telemetry.contentCaptureMode` is `SPAN_ONLY`, `EVENT_ONLY`, or `SPAN_AND_EVENT`, persisted run-event payloads still follow the `NO_CONTENT` rule unless a future spec adds a dedicated persisted-event content flag. Telemetry content capture controls spans and span events, not HarnessStorage audit retention.

## Persistence

Every `ExecutionEvent` is also written to `storage.appendEvents(runId, [event])`
from inside the run lifecycle using the privacy-safe payload mapping above.
Spec 32 owns exact contiguous-batch validation, idempotent retry, and conflict
behavior. Ordinary backend persistence failures are logged at `error` level and
counted via `harness.events.persist_errors`; they do not fail the model/tool
operation. For a lease-backed run, the terminal `run.finished` is the exception:
spec 32 `finalizeRun` appends it atomically with the terminal record, approval
receipt when present, checkpoint deletion, and lease release; failure prevents
terminal commit. Approval checkpoint transitions retain their own fenced state and
event sequence, so recovery cannot allocate a second logical event. There is no
separate persistence span; the work happens inline in the run lifecycle.

## Cross-references

- [04-state-queue-stream](./04-state-queue-stream.md) — `HarnessStorage` and event persistence.
- [11-sessions](./11-sessions.md) — `Session` API.
- [14-otel-conventions](./14-otel-conventions.md).
- [24-governance-policy](./24-governance-policy.md).

## Approved decision-boundary alignment

`model.completed` is the sole generative accounting event; safe
policy/approval payloads replace prior payloads, and final agent content follows
`beforeOutput`. Spec 42 owns the exact event union and caller correlation. The
[decision-boundary contracts](./37-decision-boundaries/03-contracts/decisions.md)
own accounting, policy, and approval semantics without defining another event
shape.
