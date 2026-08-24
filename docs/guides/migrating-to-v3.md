# Migrating To AI Harness 3

Harness 3 is a clean break that removes overlapping state and durability APIs.
The result is one storage adapter, one run record, and one recovery model.

## API Mapping

| Harness 2 | Harness 3 |
| --- | --- |
| `.state(store)` | `.storage(storage)` |
| `.runtime(runtime)` | Removed; execution persistence is part of `HarnessStorage`. |
| `.externalWait(adapter)` | Removed; waits are part of `HarnessStorage`. |
| `.checkpoints(store)` / `ctx.checkpoints` | Removed; use `ctx.step(...)` output or application storage. |
| `.workspaceStore(store)` | `.workspace(workspace)` |
| `DurableStateStore`, `StateStore` | `HarnessStorage` |
| `DurableRuntime` | Removed. |
| `DurableExternalWaitAdapter` | Removed. |
| `ContextCheckpointStore` | Removed. |
| `InMemoryStateStore` | `InMemoryHarnessStorage` |
| `SqliteDurableStateStore` | `SqliteHarnessStorage` |
| `stateStoreContract` | `harnessStorageContract` |
| `durableWorkspaceStoreContract` | `durableWorkspaceContract` |

## Local Bundle

```ts
const local = localDurableExecution({ root: './.harness' })

const harness = defineHarness()
  .storage(local.storage)
  .workspace(local.workspace)
  .sandbox(local.sandbox)
  .build()
```

The bundle is `{ storage, workspace, sandbox, close }`.

## Data Migration

There is no automatic SQLite migration. Harness 3 rejects legacy durable-run or
context-checkpoint tables with `HarnessConfigError` reason
`sqlite_schema_incompatible`. This prevents two run records or partial recovery
state from coexisting.

1. Stop all Harness 2 workers.
2. Export only application-approved session/message data if it must be retained.
3. Create a new Harness 3 database.
4. Import through a reviewed application migration, not direct table copying.
5. Start one worker and verify lease, checkpoint, wait, signal, and resume tests.
6. Roll out remaining workers only after telemetry shows the expected
   `harness.storage.*` operations.

Application business state never belonged in Harness storage. In PURISTA,
continue using the framework-level `StateStore` for general non-AI KV state and
configure Harness persistence separately as nested `ai.storage`.
