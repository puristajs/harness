# Durable Runtime, Feedback, And Operations

## Contents
- Adapter Capabilities
- Harness Inspection
- Durable Runtime
- Durable Workflow Context
- Feedback
- Readiness
- Common Failures
- Recovery

## Adapter Capabilities
Non-model adapter capabilities are separate from model capabilities:

```ts
type AdapterCapability =
  | 'sandbox.fs'
  | 'sandbox.exec'
  | 'sandbox.persistent_fs'
  | 'sandbox.snapshot'
  | 'sandbox.resume'
  | 'sandbox.hibernate'
  | 'sandbox.spawn'                 // host a long-lived process (persistent MCP stdio)
  | 'runtime.checkpoint'
  | 'runtime.retry'
  | 'runtime.distributed_lock'
  | 'runtime.resume_from_checkpoint'
  | 'runtime.workspace_checkpoint'
  | 'workspace_store.durable'       // + workspace_store.{checkpoint,resume,abort,cleanup,inspect,retention,quota,encrypted_storage}
  | 'feedback.record'
```

Use `.requires([...])` to make missing infrastructure fail during setup instead of later during execution.

## Harness Inspection
`harness.inspect()` returns a synchronous, data-only setup snapshot:

```ts
const inspection = harness.inspect()
console.log(inspection.name)
console.log(inspection.capabilities)
console.log(inspection.requiredCapabilities)
console.log(inspection.adapters)
```

It must not open sessions, call providers, hit the network, or mutate adapters.

## Durable Runtime
Durable runtime is optional. Use it when a workflow needs leases, checkpoints, retry boundaries, distributed session ownership, or resume after process failure.

```ts
import { inMemoryDurableRuntime } from '@purista/harness'

const harness = defineHarness()
  .runtime(inMemoryDurableRuntime())
  .requires(['runtime.checkpoint', 'runtime.resume_from_checkpoint'])
  .models(...)
  .agents(...)
  .workflows(...)
  .build()
```

`inMemoryDurableRuntime()` is useful for local tests; production durability needs a real adapter.

Durable runtime concepts:
- `DurableRunStart`: run/session/worker/step/input metadata
- `DurableRunLease`: exclusive ownership token
- `RunCheckpoint`: committed resumable boundary
- `FinishRunPatch`: terminal status/output/error
- terminal statuses: `succeeded`, `failed`, `cancelled`

Errors:
- `DurableRunLeaseError` when a run/session is already owned or lease metadata does not match
- `DurableTerminalRunError` when attempting to resume a terminal run
- `DurableStepError` when a durable step fails

## Durable Workflow Context
The runtime exports `createDurableWorkflowContext` and step helpers for checkpointed code paths. Keep durable checkpoints at deterministic boundaries; do not treat live streams as recovery state.

Recovery starts from the last committed checkpoint, not from the last observed stream event.

### Auto-wiring through the session run loop
Durable execution is opt-in **per workflow call**. Mark boundaries in the handler with `ctx.step(stepId, fn)` and invoke with a stable `durable.runId`:

```ts
const harness = defineHarness()
  .runtime(inMemoryDurableRuntime())     // executable DurableRuntime
  .workspaceStore(inMemoryDurableWorkspaceStore())  // optional
  .models(...).agents(...)
  .workflows({
    job: {
      handler: async (ctx) => {
        const a = await ctx.step('a', () => ctx.agents.prepare(ctx.input))
        return ctx.step('b', () => ctx.agents.finish(a))
      },
    },
  })
  .build()

const session = await harness.getSession('s1')
await session.workflows.job.prompt(input, { durable: { runId: 'job-2026-06-09' } })
```

Rules:
- Workflow-only. `opts.durable` on an agent run throws `ValidationError`; without an executable `.runtime(...)` it throws `HarnessConfigError{reason:'durable_runtime_required'}`.
- The harness acquires a lease for `durable.runId`, injects durable `ctx.step`, finalizes `finishRun`, and (with a workspace store) starts/resumes the workspace, writes a workspace checkpoint before each runtime checkpoint, cleans up on success when retention `cleanupMode` is `adapter_automatic`, aborts on cancellation, and leaves a non-cancel failure resumable.
- A committed step replays its stored output on resume without re-running its body. Without `durable`, `ctx.step` is a transparent pass-through.
- Resume across process restart needs runtime/workspace adapters that persist beyond process exit; the in-memory adapters are local/test only.

## Feedback
Feedback is optional and application-owned. Core exports shared types and test helpers, not a production feedback store.

Targets:

```ts
type FeedbackTarget =
  | { kind: 'run'; runId: string }
  | { kind: 'message'; sessionId: string; messageId: string }
  | { kind: 'tool_call'; runId: string; callId: string }
  | { kind: 'agent_invocation'; runId: string; agentId: string }
```

Record shape:

```ts
{
  id: string,
  target,
  source: 'user' | 'application' | 'deterministic_rule' | 'evaluator' | 'human_review',
  label: string,
  score?: number,
  comment?: string,
  metadata?: Record<string, JsonValue>,
  createdAt: string
}
```

Use `createInMemoryFeedbackRecorder()` from `@purista/harness/testing` for tests and examples.

## Readiness
Before exposing a harness-backed service:
- verify `harness.inspect()` includes required capabilities
- verify session creation
- smoke-test every public agent/workflow entrypoint
- test tool/MCP/model failure mapping
- test cancellation and timeout behavior
- confirm logs/traces include `session_id` and `run_id`
- verify `harness.shutdown()` closes providers, state stores, sandboxes, and MCP runners

## Common Failures
| Symptom | Likely Cause | Action |
|---|---|---|
| `SessionBusyError` | Two runs in one session. | Use distinct sessions or wait. |
| `OperationTimeoutError` | Run/model/tool exceeded budget. | Tune defaults and inspect latency. |
| `ValidationError` | Schema mismatch. | Inspect Zod issues in `meta`. |
| `ModelCapabilityError` | Alias lacks capability or provider method. | Fix alias capabilities/provider adapter. |
| `SandboxNoExecutorError` | Exec requested in files-only sandbox. | Use `bashSandbox()` or disable exec path. |
| `McpProtocolError` | MCP connect/list/call failed. | Check command/url/schema/stderr. |
| `McpAuthError` | HTTP MCP auth failed. | Check token/auth config. |

## Recovery
1. Capture `runId` and `sessionId`.
2. Inspect logs and trace by those ids.
3. Inspect final `run.finished` error payload.
4. Check state/event persistence for the run.
5. For durable runs, inspect last committed checkpoint and lease state.
6. Fix provider/tool/sandbox/config issue.
7. Re-run a smoke test.
8. Shut down cleanly with `harness.shutdown()`.
