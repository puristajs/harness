# Configuration

## Contents
- Package Setup
- Builder Order
- Model Setup
- Sessions
- Optional Governance
- Defaults, Logs, And Telemetry
- Storage, Sandbox, Workspace, And Requirements
- Streaming
- Shutdown

## Package Setup
Install the core package and only the provider/addon packages the application actually needs:

```bash
npm install @purista/harness @purista/harness-openai zod
```

Optional peer dependencies:
- `@modelcontextprotocol/client` for MCP stdio/http tools
- `just-bash` for `bashSandbox()`
- `@opentelemetry/api` for connecting spans to an existing OpenTelemetry context

The packages are ESM-only.

## Builder Order
Prefer this order because it preserves inference and mirrors dependency direction:

```ts
defineHarness({ name: 'app-name' })
  .telemetry(...)
  .logger(...)
  .storage(...)
  .sandbox(...)
  .memory(...)
  .workspace(...)
  .requires(...)
  .defaults(...)
  .models(...)
  .tools(...)
  .skills(...)
  .agents(({ agent }) => ({ ... }))
  .workflows(({ workflow }) => ({ ... }))
  .governance(...)
  .build()
```

Models must exist before agents reference them. Agents must exist before workflows call them. Tools and skills must exist before agents allowlist them.
Governance is optional and should be added only when the app needs policy-driven exposure, execution decisions, approvals, audits, or an external policy engine.

## Model Setup
Read `model-setup.md` when adding or changing providers, capabilities, embeddings, rerank, multimodal input, or per-call options. Keep this file focused on the harness graph and runtime wiring.

## Sessions
Application code runs through sessions:

```ts
const session = await harness.getSession('tenant-a:user-42')
const output = await session.agents.assistant.prompt(input)

for await (const event of session.workflows.review.stream(input)) {
  if (event.type === 'run.finished') console.log(event.output)
}
```

Sessions provide `agents`, `workflows`, `memory`, `history`, `clearHistory`,
`replaceHistory`, `release`, and `close`. Call `release()` when an idle
request is done: it releases live sandbox/MCP resources while retaining
`HarnessStorage`-backed history and runs. `close()` is the destructive operation
that deletes the session and its persisted Harness data.

Use stable, tenant-safe session ids. One session has one active run at a time; use separate session ids for parallel user threads.

## Optional Governance
Use `.governance(...)` after agents/workflows when policy is needed. Ordinary
harness apps should omit it.

Governance can contain `exposure` rules, execution `policies`, or both. Exposure
rules shape the provider-visible tool list before each model step. Execution
policies evaluate a concrete tool call before handler execution. See
`agents-workflows-tools.md` for typed `exposureRule(...)`, `rule(...)`,
approval, audit, and external adapter patterns.

## Defaults, Logs, And Telemetry
Set explicit budgets for production:

```ts
.defaults({
  runTimeoutMs: 600_000,
  modelTimeoutMs: 300_000,
  toolTimeoutMs: 120_000,
  skillTimeoutMs: 60_000,
  agentMaxIterations: 16,
  maxParallelToolCalls: 8,
  historyWindow: 20,
  historyRetention: { maxTurns: 50, maxBytes: 256_000 }
})
.logger(new JsonLogger({ level: process.env.PURISTA_HARNESS_LOG_LEVEL ?? 'info' }))
.telemetry({ contentCaptureMode: 'NO_CONTENT' })
```

`contentCaptureMode` defaults to `NO_CONTENT`. Model providers, tools, Harness
storage, and sandboxes can inherit logger and telemetry via
`configureHarnessContext`.

`agentMaxIterations` and an agent's `maxSteps` are positive integer budgets.
Explicit values have no hard upper cap, so choose a finite limit appropriate to
the workflow and keep run/model timeouts configured.

`historyRetention` bounds durable conversation storage by retaining whole
newest turns. It requires an atomic `HarnessStorage.replaceMessages` implementation
at build time; the Harness never uses a non-atomic trim/write fallback. Its
`maxBytes` limit counts serialized UTF-8 persisted records, not model tokens.
Keep transient request context separate: use `historyWindow` for a simple
message-count limit, or model/provider token information for an exact context
budget.

The implementation creates an OpenTelemetry-backed `TelemetryShim` internally when telemetry is configured. Applications still own SDK/exporter bootstrapping, for example using `@opentelemetry/sdk-node` plus an OTLP exporter before harness runs begin.

Workflow, custom-agent, and TypeScript-tool handlers receive `ctx.metrics` for
application-owned counters, histograms, and duration measurements. Prefer this
helper over low-level `ctx.telemetry.record*` calls.

Cancellation uses `InvokeOptions.signal` and per-call `timeoutMs`.
Timeout/cancel propagates to workflow/custom-agent handlers, model calls, tools,
memory, and sandbox operations. Workflow and custom-agent handlers are raced
against the signal so the run can reach a terminal state even if handler code
does not poll the signal. Logs and spans expose normalized harness errors;
timeout/cancel paths include `harness.error.scope` and timeout paths include
`harness.error.timeout_ms`.

`BaseModelProvider` races each model operation and pending stream chunk against
the effective signal, so a model timeout or caller cancellation is terminal
even if a provider SDK ignores abort. The SDK work itself can continue until it
observes `req.signal`, so adapters should still propagate that signal promptly.

## Storage, Sandbox, Workspace, And Requirements
Defaults:
- storage: `InMemoryHarnessStorage`
- sandbox: `autoDetectSandbox()` when `.sandbox()` is omitted or called with no argument
- memory: `sandboxMemory()` when `.memory(...)` is omitted
- logger: `JsonLogger`
- telemetry shim: created internally; `.telemetry(...)` supplies options such as `contentCaptureMode`

Use explicit infrastructure in production:

```ts
defineHarness({ name: 'research-service' })
  .storage(distributedHarnessStorage)
  .sandbox(bashSandbox({ network: { deny: ['169.254.169.254'] } }))
  .memory(persistentMemory)
  .workspace(distributedWorkspace)
  .requires(['sandbox.fs', 'sandbox.exec', 'memory.persistent', 'storage.multi_instance', 'workspace.persistent'])
  .models(...)
  .agents(...)
  .build()
```

`.requires(...)` validates adapter capabilities during setup. Use it to fail
fast when a required sandbox, memory, storage, or workspace capability is
missing. `HarnessStorage` is the Harness persistence port; it is not PURISTA's
general-purpose `StateStore`.

## Streaming
Harness stream methods return typed `RunEvent` values:

```ts
for await (const event of session.agents.triage.stream(input)) {
  if (event.type === 'tool.started') console.log(event.toolId)
  if (event.type === 'model.delta') process.stdout.write(event.delta)
  if (event.type === 'model.object.partial') renderDraft(event.partial)
}
```

`prompt(...)`, `ctx.models.alias.text(...)`, and `ctx.models.alias.object(...)`
return final results only. Consumed `textStream(...)` and `objectStream(...)`
chunks stay private by default. To publish a specific public-facing stream
through `session.*.stream(...)`, pass `{ emitRunEvents: true }` to that model
stream call. Harness-emitted model stream events include a generated `streamId`,
`modelAlias`, and available `workflowId` / `agentId`; UI labels and client event
names belong in the application adapter. The default
structured agent loop uses `object(...)`, so it emits final `model.object`
events, not text deltas.

Do not treat harness streams as a client HTTP protocol. Map `RunEvent` into application-owned SSE, WebSocket, or queue events at the integration edge.

## Shutdown
Release each request/session and shut down the shared harness resources:

```ts
await session.release()
const shutdown = await harness.shutdown()
if (shutdown.errors.length) logger.error('Harness shutdown errors.', { errors: shutdown.errors })
```

Provider clients, MCP runners, Harness storage, and sandboxes may own resources that need shutdown.
Use `session.close()` only when the caller deliberately deletes the conversation
and its persisted runs/events.
# Static module composition

Use `defineHarnessModule<Required>()('id', { register(builder) { ... } })`
when configuration needs to live in a local file or addon package. `Required`
states the already-configured literal keys the module needs; call `.use(module)`
only after those contributions. Modules may contribute models, tools, skills,
agents, and workflows. They cannot build/load a harness or supply shutdown
hooks. Duplicate ids fail rather than override earlier definitions.

`HarnessDefaults.contextProjection`, `ModelAlias.contextProjection`, and
`InvokeOptions.contextProjection` select a retry-only tool-result projection;
the explicit invocation wins, then model alias, then harness default. The first
request is unchanged and only one context-length retry is attempted.
