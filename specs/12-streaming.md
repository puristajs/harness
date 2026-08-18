# Streaming

**Purpose.** Defines the `RunEvent` tagged union, ordering guarantees, bounded live observation, and privacy-safe persistence rule. Streaming is internal to the harness: there is no pluggable stream adapter.

## `RunEvent`

```ts
type RunEvent =
  | { type: 'run.started';     runId: string; at: string }
  | { type: 'run.finished';    runId: string; at: string; output?: JsonValue; error?: SerializedError }
  | { type: 'fanout.started';  runId: string; batchId: string; at: string; count: number; concurrency: number }
  | { type: 'fanout.finished'; runId: string; batchId: string; at: string; count: number; status: 'succeeded'|'failed'|'cancelled' }
  | { type: 'child_task.started'; runId: string; taskId: string; at: string; parentRunId: string; workflowId: string; agentId: string; modelAlias: string; contextPolicy: 'isolated'; mode: 'one_shot'|'continuable' }
  | { type: 'child_task.settled'; runId: string; taskId: string; at: string; parentRunId: string; workflowId: string; agentId: string; status: 'succeeded'|'failed'|'cancelled'; error?: SerializedError }

  | { type: 'agent.started';   runId: string; agentId: string; at: string; workflowId?: string; parentAgentId?: string; delegationCallId?: string; delegationDepth?: number; modelAlias?: string }
  | { type: 'agent.finished';  runId: string; agentId: string; at: string; workflowId?: string; parentAgentId?: string; delegationCallId?: string; delegationDepth?: number; modelAlias?: string; output?: JsonValue; error?: SerializedError }

  | { type: 'model.delta';     runId: string; streamId: string; agentId?: string; workflowId?: string; modelAlias?: string; delta: string }
  | { type: 'model.message';   runId: string; agentId: string; message: Message }
  | { type: 'model.object.partial'; runId: string; streamId: string; agentId?: string; workflowId?: string; modelAlias?: string; partial: JsonValue }
  | { type: 'model.object';    runId: string; agentId?: string; workflowId?: string; modelAlias?: string; streamId?: string; object: JsonValue }
  | { type: 'model.embedding.completed'; runId: string; agentId?: string; count: number; dimensions?: number; usage?: TokenUsage }
  | { type: 'model.rerank.completed'; runId: string; agentId?: string; count: number; topN?: number; usage?: TokenUsage }

  | { type: 'policy.evaluated'; runId: string; agentId: string; toolId: string; callId: string; decisionId: string; policyId: string; policyVersion?: string; ruleId?: string; effect: GovernanceEffect; enforced: boolean; message?: string; reason?: string; riskLevel?: GovernanceRiskLevel; tags?: readonly string[] }
  | { type: 'policy.exposure'; runId: string; agentId: string; toolId: string; decisionId: string; policyId: string; policyVersion?: string; ruleId?: string; effect: GovernanceExposureEffect; enforced: boolean; step: number; message?: string; reason?: string; riskLevel?: GovernanceRiskLevel; tags?: readonly string[] }
  | { type: 'approval.requested'; runId: string; agentId: string; toolId: string; callId: string; approvalId: string; decisionId: string; policyId: string; policyVersion?: string; ruleId?: string }
  | { type: 'approval.finished'; runId: string; agentId: string; toolId: string; callId: string; approvalId: string; decisionId: string; policyId: string; policyVersion?: string; ruleId?: string; decision: 'approved'|'rejected'; approverId?: string; reason?: string }

  | { type: 'tool.started';    runId: string; agentId: string; toolId: string; callId: string; input: JsonValue }
  | { type: 'tool.finished';   runId: string; agentId: string; toolId: string; callId: string; output?: JsonValue; error?: SerializedError }

  | { type: 'skill.started';   runId: string; agentId: string; skillId: string; callId: string; input: JsonValue }
  | { type: 'skill.finished';  runId: string; agentId: string; skillId: string; callId: string; output?: JsonValue; error?: SerializedError }

interface SerializedError {
  code: string
  category: ErrorCategory
  retriable: boolean
  message: string
  meta?: Record<string, JsonValue>
}
```

`SerializedError` is the canonical shape for error fields anywhere a `HarnessError` is exposed via persisted state or the run queue — including `RunRecord.error` (see [04-state-queue-stream](./04-state-queue-stream.md)).

`at` is ISO 8601 UTC. `callId` is `tc_<ulid>` for tool calls and `sk_<ulid>` for skill calls; the same id appears in `started` and `finished`. `delegationCallId` is `delegate_<ulid>` for workflow-local child-agent calls and appears on the matching `agent.started` / `agent.finished` pair.

Fan-out and child-task lifecycle events are content-free operational metadata.
Child task events belong to the child task's own run stream, not the parent
workflow stream. See [28-workflow-child-tasks](./28-workflow-child-tasks.md).

`text(...)` and `object(...)` are final request-response model calls and do not
emit partial run events. Consumed `textStream(...)` and `objectStream(...)`
chunks stay private by default. A model stream call emits `model.delta`,
`model.object.partial`, and streamed final `model.object` only when the call
passes `{ emitRunEvents: true }` in its model invocation context. For those
opted-in stream events, `streamId` is generated by the harness and is unique per
model stream invocation. `modelAlias` is included for harness-emitted model
stream events, and `workflowId` / `agentId` are included when available. UI
labels, semantic buckets, and client protocol names belong in the application
integration layer, not in `RunEvent`.

Within a workflow or custom agent handler, passing `{ emitRunEvents: true }` to
`object(...)`, `embed(...)`, or `rerank(...)` emits the corresponding final
completion event. The enclosing session supplies the immutable run identity;
handler-provided invocation context cannot relabel a run, workflow, or agent.

The harness does NOT auto-emit log-style events from logger calls; there is no `'log'` variant in `RunEvent`. Loggers and run events are independent surfaces.

## Streaming API

```ts
session.workflows[id].stream(input, opts?): AsyncIterable<RunEvent>
```

Each `prompt`/`stream` invocation creates an internal async generator. Events are appended to an in-process bounded queue scoped to the run. `stream()` returns an `AsyncIterable<RunEvent>` reading from that queue. Consumer slowness MUST NOT pause model/tool/workflow execution. Persistence of events for audit goes through `StateStore.appendEvents`. There is no pluggable stream adapter and no `Stream` port.

- The first event is always `run.started` (with `runId` matching the iterator's run).
- The last event is always `run.finished`.
- After `run.finished` is yielded, the iterator returns `{done: true}`.
- If the consumer breaks early or aborts, the run continues (it is not cancelled by stream consumer disconnect). Use `opts.signal` to cancel the run.
- If `opts.signal` aborts, the run aborts; the iterator yields a final `run.finished` with `error` set, then ends.
- The non-streaming `prompt(...)` variant still drives the same lifecycle internally; events are appended and persisted, but no consumer reads them.

## Ordering guarantees

1. Per-run total order: events for a given `runId` are yielded in the order they are produced.
2. `run.started` precedes every other event for the run.
3. `run.finished` succeeds every other event for the run.
4. For each tool call, `tool.started` precedes `tool.finished` (same `callId`). Tool events for different `callId` values may interleave when one model response returns multiple tool calls. Same for skills.
5. For each agent call, `agent.started` precedes `agent.finished`.
6. `model.delta` events for a given `streamId` are yielded in provider chunk order.
7. `model.object.partial` events for a given `streamId` are yielded in provider chunk order; a streamed `model.object` is yielded at most once for the final object AFTER all partials for that `streamId`.
8. When governance exposure is configured, `policy.exposure` events may precede a model call and never include tool input or output. When execution governance is configured, `policy.evaluated` and approval events for a tool call precede `tool.started`. A denied policy or rejected approval may emit `tool.finished` with a serialized error without emitting `tool.started`, because the side-effecting tool never began.

No ordering is guaranteed *across* runs (only within a run).

## Bounded Live Observation

The run queue is bounded. Consumer slowness does not pause the producer:

- The harness buffers live events up to an implementation-defined limit.
- On overflow, the harness drops oldest non-terminal live events and emits a sanitized `stream.overflow` event with a dropped count.
- Persisted audit events remain authoritative and are not dropped because a live consumer is slow.

Implications:

- A slow UI consumer may miss non-terminal live events under overflow.
- Terminal run state is persisted via `StateStore`; consumers needing full history must call `state.listEvents(runId)`.

## Subscriber failures

If a consumer's `take()` throws (e.g. consumer code rejects), the harness removes that subscription, logs `warn` with `harness.error.code='STREAM_SUBSCRIBER_FAILED'`, and continues the run. Other consumers are unaffected. The consumer error is never re-thrown into the run. `STREAM_SUBSCRIBER_FAILED` is a log code, not an error class.

## Privacy-safe persisted event payloads

Persisted event payloads are sanitized by default. `runId`, `at`, and `type` are stored as `PersistedRunEvent` fields and are not duplicated inside `payload`.

When `telemetry.contentCaptureMode` is `NO_CONTENT` or omitted, prompts, model outputs, structured object payloads, tool inputs/results, memory, files, and user data MUST NOT be stored in persisted event payloads. Payloads may include operational metadata such as ids, status, counts, dimensions, `topN`, usage, stream source metadata (`streamId`, `modelAlias`, `workflowId`, `agentId`), child-agent lineage metadata (`delegationCallId`, `delegationDepth`, `parentAgentId`), and serialized harness errors.

Governance event payloads may include `policyId`, `ruleId`, `effect`, `enforced`, approval `decision`, `approverId`, and `reason`. They MUST NOT include raw tool input or tool output.

When `telemetry.contentCaptureMode` is `SPAN_ONLY`, `EVENT_ONLY`, or `SPAN_AND_EVENT`, persisted run-event payloads still follow the `NO_CONTENT` rule unless a future spec adds a dedicated persisted-event content flag. Telemetry content capture controls spans and span events, not StateStore audit retention.

## Persistence

Every `RunEvent` is also written to `state.appendEvents(runId, [event])` from inside the run lifecycle using the privacy-safe payload mapping above. Persistence failures are logged at `error` level and counted via `harness.events.persist_errors`; they do NOT fail the run. There is no separate persistence span — the work happens inline in the run lifecycle.

## Cross-references

- [04-state-queue-stream](./04-state-queue-stream.md) — `StateStore` and event persistence.
- [11-sessions](./11-sessions.md) — `Session` API.
- [14-otel-conventions](./14-otel-conventions.md).
- [24-governance-policy](./24-governance-policy.md).
