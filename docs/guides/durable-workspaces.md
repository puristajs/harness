# Durable Execution and Workspaces

Durable execution lets a workflow resume from committed checkpoints after a
retry or process restart. A durable workspace links those checkpoints to
persistent files.

## Start locally

`localDurableExecution` provides SQLite storage, a local sandbox, and a local
workspace adapter that share one coordinator:

```ts
import {
  defineHarness,
  defineWorkflow,
  localDurableExecution,
} from '@purista/harness'

const local = localDurableExecution({
  root: '.purista/durable',
  exec: false,
})

const report = defineWorkflow('report', {
  input,
  output,
  durable: true,
  workspace: true,
  async handler(ctx) {
    const outline = await ctx.step('outline', async () => createOutline(ctx.input))
    return ctx.step('render', async () => renderReport(outline))
  },
})

const definition = defineHarness({
  name: 'reports',
  revision: '2026-09-07',
}).addWorkflow(report)

const instance = await definition.getInstance({
  storage: local.storage,
  sandbox: local.sandbox,
  workspace: local.workspace,
})
```

`revision` identifies the deployed definition used for replay. Change it when
a release changes durable behavior.

## Invoke with a stable run id

```ts
const session = await instance.getSession('report-session')
const outcome = await session.workflows.report.run(input, {
  durable: { runId: 'report-42' },
  idempotencyKey: 'report-42',
})
```

The session id identifies conversation state. The durable run id identifies one
workflow execution and its checkpoints.

## Write replay-safe steps

`ctx.step(stepId, handler)` stores one JSON-compatible result. Use stable step
ids and put each external side effect behind its own step. A retry returns the
committed value instead of executing the handler again.

Do not hide multiple unrelated effects inside one step. If the process can fail
between two writes, make them separate steps or use an application-owned
transactional outbox.

## Use a workspace

A workflow with `workspace: true` receives a sandbox bound to its durable
workspace lifecycle. The graph requires:

- a `HarnessStorage` with persistent durability;
- a sandbox advertising `sandbox.workspace_binding`;
- a `DurableWorkspace` adapter.

The workspace adapter checkpoints, restores, retains, and cleans workspace
state. The sandbox owns file and process operations. Their responsibilities are
separate even when one local helper creates both.

## Pause and resume

Tool approval and `ctx.externalWait.wait(...)` return an `interrupted`
outcome. Persist the run id and interrupt revision. After an authenticated and
authorized decision, signal the wait or pass a correlated approval resume and
invoke the same durable run again.

Invalid, expired, duplicate, or mismatched decisions fail closed.

## Production adapters

Use `@purista/harness-storage-postgres` for distributed state. Combine it with
a sandbox and workspace implementation that provide the durability guarantees
your deployment needs. Kubernetes deployments can use
`@purista/harness-sandbox-kubernetes`.

Verify adapter capability metadata at startup and run the exported storage and
sandbox conformance suites for custom adapters.

## Shut down

```ts
await session.release()
await instance.close()
await local.close()
```

The instance closes Harness-owned resources. Close application-owned adapter
bundles separately when their factory exposes a close method.
