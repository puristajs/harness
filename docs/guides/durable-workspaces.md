# Durable Workspaces

Durable workspaces are the production replay surface for runs that need to
pause, resume, retry, or recover with workspace state intact.

Sandbox snapshot support and durable workspace replay are different guarantees:

| Capability | Meaning |
|---|---|
| `sandbox.snapshot` | A sandbox adapter can capture one sandbox session. |
| `sandbox.resume` | A sandbox adapter can reopen a captured sandbox session. |
| `workspace_store.durable` | A workspace store persists replay state beyond process exit. |
| `workspace_store.retention` | The store reports effective expiry and cleanup policy. |
| `workspace_store.encrypted_storage` | The store encrypts checkpoint payloads, snapshots, files, and metadata at rest. |
| `workspace_store.quota` | The store enforces workspace size, file, age, and concurrency limits. |

Use durable workspaces for long-running agent workflows, offline eval jobs,
dataset backfills, optimization jobs, and production measurement runs where a
fresh sandbox restart would lose useful execution state.

## Configuration Shape

```ts
const harness = defineHarness()
  .runtime(durableRuntime)
  .workspaceStore(durableWorkspace)
  .requires([
    'runtime.workspace_checkpoint',
    'workspace_store.durable',
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
