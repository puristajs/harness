# Durable Workspaces

Durable workspaces are the production replay surface for runs that need to
pause, resume, retry, or recover with workspace state intact.

Sandbox snapshot support and durable workspace replay are different guarantees:

| Capability | Meaning |
|---|---|
| `sandbox.snapshot` | A sandbox adapter can capture one sandbox session. |
| `sandbox.resume` | A sandbox adapter can reopen a captured sandbox session. |
| `runtime.persistent` | Runtime checkpoints, leases, and terminal state survive process exit. |
| `workspace_store.durable` | A workspace store implements the durable workspace lifecycle. |
| `workspace_store.persistent` | Workspace checkpoints survive process exit. |
| `workspace_store.retention` | The store reports effective expiry and cleanup policy. |
| `workspace_store.encrypted_storage` | The store encrypts checkpoint payloads, snapshots, files, and metadata at rest. |
| `workspace_store.quota` | The store enforces workspace size, file, age, and concurrency limits. |

Use durable workspaces for long-running agent workflows, offline eval jobs,
dataset backfills, optimization jobs, and production measurement runs where a
fresh sandbox restart would lose useful execution state.

## Local Durable Execution

For local development and single-host deployments, start with the built-in
SQLite + host-directory bundle:

```ts
import { defineHarness, localDurableExecution } from '@purista/harness'

const local = localDurableExecution({
  root: '.purista/harness',
  exec: false
})

const harness = defineHarness()
  .state(local.state)
  .sandbox(local.sandbox)
  .workspaceStore(local.workspaceStore)
  .requires([
    'runtime.persistent',
    'runtime.workspace_checkpoint',
    'workspace_store.persistent',
    'workspace_store.checkpoint',
    'workspace_store.resume',
    'context_checkpoint.persistent',
  ])
  .models(models)
  .agents(agents)
  .workflows(workflows)
  .build()
```

`localDurableExecution` stores run state, durable runtime checkpoints, context
checkpoints, and workspace snapshots under the configured root. The sandbox maps
virtual `/workspace` to the active durable workspace. Host command execution is
disabled by default; enabling `exec` is a trust decision because this adapter is
a host-directory persistence adapter, not a Docker or microVM isolation layer.

When `exec` is enabled, commands never run through a shell: the command line is
tokenized and spawned as an argv array, unquoted shell metacharacters are
rejected when `allowCommands` is configured, captured output is capped at
10 MiB per stream, and the per-command timeout falls back to the harness
`toolTimeoutMs`. Files-only mode (`exec: false`) advertises
`['sandbox.fs', 'sandbox.persistent_fs']`; enabling `exec` adds `sandbox.exec`.

## Configuration Shape

```ts
const harness = defineHarness()
  .runtime(durableRuntime)
  .workspaceStore(durableWorkspace)
  .requires([
    'runtime.persistent',
    'runtime.workspace_checkpoint',
    'workspace_store.durable',
    'workspace_store.persistent',
    'workspace_store.checkpoint',
    'workspace_store.resume',
    'workspace_store.cleanup',
    'workspace_store.retention',
    'workspace_store.encrypted_storage',
    'workspace_store.quota',
  ])
  .models(models)
  .agents(agents)
  .build()
```

`.requires(...)` is the fail-fast guard. The harness never silently downgrades
from durable replay to ephemeral execution.

## Out-of-the-box Store

`inMemoryDurableWorkspaceStore()` is included for local development, examples,
and tests:

```ts
import { defineHarness, inMemoryDurableWorkspaceStore } from '@purista/harness'

const harness = defineHarness()
  .workspaceStore(inMemoryDurableWorkspaceStore())
  .requires(['workspace_store.durable', 'workspace_store.checkpoint', 'workspace_store.resume'])
  .models(models)
  .agents(agents)
  .build()
```

The in-memory store is process-local. It is not a production persistence layer
and does not survive process restart.

## Running a durable workflow

Durable execution is opt-in **per call** and applies to workflow runs only.
Mark replayable boundaries in the handler with `ctx.step(...)`, then invoke the
workflow with a stable `durable.runId`:

```ts
const harness = defineHarness()
  .runtime(durableRuntime)              // an executable DurableRuntime, e.g. inMemoryDurableRuntime()
  .workspaceStore(durableWorkspace)     // optional; enables workspace checkpoints
  .models(models)
  .agents(agents)
  .workflows({
    research: {
      input: z.object({ topic: z.string() }),
      output: z.string(),
      delegation: { agents: ['outline', 'write'] },
      handler: async (ctx) => {
        // Each step is checkpointed; on resume it replays its stored output
        // without re-running the body.
                  const outline = await ctx.step('outline', () => ctx.agents.outline(ctx.input.topic), {
                    retry: { maxAttempts: 3, minDelayMs: 250, maxDelayMs: 2_000 }
                  })
                  const draft = await ctx.step('draft', () => ctx.agents.write(outline))
                  return draft
      },
    },
  })
  .build()

const session = await harness.getSession('user-42')
// First call runs both steps. If the process crashes after "outline" commits,
// re-invoking with the same runId replays "outline" and only runs "draft".
const result = await session.workflows.research.prompt(
  { topic: 'durable execution' },
  { durable: { runId: 'research-2026-06-09-user-42' } },
)
```

Behavior (see [spec 21 §16.1](../../specs/21-durable-workspaces.md)):

- The harness acquires a runtime lease for `durable.runId`, injects a durable
  `ctx.step`, and finalizes the runtime (`finishRun`) on success/cancel. A
  terminal `failed` status is recorded with its sanitized error and releases the
  lease, but only `succeeded` and `cancelled` block resume — a failed run stays
  resumable by a retry with the same `runId`.
- With a workspace store configured, it starts (or resumes) the durable
  workspace, writes a workspace checkpoint before each runtime checkpoint, and —
  when the store's retention `cleanupMode` is `adapter_automatic` — cleans up on
  terminal success. Cancellation aborts the workspace; a non-cancel failure
  leaves it resumable for a retry with the same `runId`.
- `ctx.step(..., { retry })` retries the step body before checkpoint commit.
  Replayed committed steps return the stored output without re-running the body
  or retry policy.
- Without `durable`, `ctx.step(...)` is a transparent pass-through that still
  honors short retry options, so the same workflow body runs ephemerally with no
  code change.
- Supplying `durable` without an executable `.runtime(...)` throws
  `HarnessConfigError{reason:'durable_runtime_required'}`; supplying it on an
  agent run throws `ValidationError`.

For workflows that may outlive one deployment, include an application
`workflowVersion` in workflow input or invoke metadata, keep durable step output
schemas backward-compatible, and start a new durable run when a major migration
needs a new code path. Store the previous run id in metadata so audit and UI
views can link the logical process across versions.

Resume across an actual process restart additionally requires
`runtime.persistent` and `workspace_store.persistent`. The in-memory adapters
are local/test only; `localDurableExecution(...)` is the built-in persistent
single-host option.

## Context Checkpoints

Use `ctx.checkpoints` for explicit long-horizon handoff records:

```ts
await ctx.checkpoints.write({
  sequence: 1,
  kind: 'summary',
  payload: { completed: ['outline'], next: 'draft' }
})
```

The harness never auto-summarizes or rewrites prompts. Context checkpoints are
typed JSON records that your workflow or agent writes deliberately. They are
stored by the configured checkpoint adapter and traced without raw payload
content.

## Replay Boundary

At a replay boundary, workspace state is written first and the runtime
checkpoint referencing it is committed second. If the workspace write succeeds
and the runtime checkpoint fails, the workspace checkpoint is an orphan and can
be cleaned. If the runtime checkpoint succeeds and the process crashes before
the caller receives the result, retrying with the same idempotency key returns
the same checkpoint references.

## Policy Ownership

Harness core owns the generic adapter contract. Applications and product layers
own concrete policy values:

- retention durations;
- encryption key scope and rotation;
- tenant/project quotas;
- cleanup scheduling;
- product records, UI, billing, and usage reports.

CloudGrid can use durable workspace stores for production replay while still
owning datasets, evaluation runs, result records, comparisons, and promotion
evidence outside harness core.

## Privacy

Workspace references are returned to callers and stored in checkpoint records,
but logs, spans, and metrics emit only hashed references. Workspace file
content, checkpoint payload content, prompts, completions, tool inputs, tool
outputs, provider credentials, tokens, raw headers, and attachments are not
emitted by harness telemetry.

## Testing

Stores must pass the durable workspace contract suite:

```ts
import { durableWorkspaceStoreContract } from '@purista/harness/testing'

durableWorkspaceStoreContract(() => makeDurableWorkspaceStore())
```

Application tests should cover missing capabilities, resume from a committed
checkpoint, cleanup retry, quota exceeded behavior, and explicit ephemeral
non-durable restart policy when the application declares `required:false`.
