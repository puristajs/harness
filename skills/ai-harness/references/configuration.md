# Configuration

## Contents
- Package Setup
- Builder Order
- Model Setup
- Sessions
- Defaults, Logs, And Telemetry
- State, Sandbox, Runtime, And Requirements
- Streaming
- Shutdown

## Package Setup
Install the core package and only the provider/addon packages the application actually needs:

```bash
npm install @purista/harness @purista/harness-openai zod
```

Optional peer dependencies:
- `@modelcontextprotocol/sdk` for MCP stdio/http tools
- `just-bash` for `bashSandbox()`
- `@opentelemetry/api` for connecting spans to an existing OpenTelemetry context

The packages are ESM-only.

## Builder Order
Prefer this order because it preserves inference and mirrors dependency direction:

```ts
defineHarness({ name: 'app-name' })
  .telemetry(...)
  .logger(...)
  .state(...)
  .sandbox(...)
  .memory(...)
  .runtime(...)
  .requires(...)
  .defaults(...)
  .models(...)
  .tools(...)
  .skills(...)
  .agents(({ agent }) => ({ ... }))
  .workflows(({ workflow }) => ({ ... }))
  .build()
```

Models must exist before agents reference them. Agents must exist before workflows call them. Tools and skills must exist before agents allowlist them.

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

Sessions provide `agents`, `workflows`, `memory`, `history`, `clearHistory`, `replaceHistory`, and `close`.

Use stable, tenant-safe session ids. One session has one active run at a time; use separate session ids for parallel user threads.

## Defaults, Logs, And Telemetry
Set explicit budgets for production:

```ts
.defaults({
  runTimeoutMs: 600_000,
  modelTimeoutMs: 300_000,
  toolTimeoutMs: 120_000,
  skillTimeoutMs: 60_000,
  agentMaxIterations: 16,
  historyWindow: 20
})
.logger(new JsonLogger({ level: process.env.PURISTA_HARNESS_LOG_LEVEL ?? 'info' }))
.telemetry({ contentCaptureMode: 'NO_CONTENT' })
```

`contentCaptureMode` defaults to `NO_CONTENT`. Model providers, tools, state
stores, and sandboxes can inherit logger and telemetry via
`configureHarnessContext`.

The implementation creates an OpenTelemetry-backed `TelemetryShim` internally when telemetry is configured. Applications still own SDK/exporter bootstrapping, for example using `@opentelemetry/sdk-node` plus an OTLP exporter before harness runs begin.

Workflow, custom-agent, and TypeScript-tool handlers receive `ctx.metrics` for
application-owned counters, histograms, and duration measurements. Prefer this
helper over low-level `ctx.telemetry.record*` calls.

## State, Sandbox, Runtime, And Requirements
Defaults:
- state: `InMemoryStateStore`
- sandbox: `autoDetectSandbox()` when `.sandbox()` is omitted or called with no argument
- memory: `sandboxMemory()` when `.memory(...)` is omitted
- logger: `JsonLogger`
- telemetry shim: created internally; `.telemetry(...)` supplies options such as `contentCaptureMode`

Use explicit infrastructure in production:

```ts
defineHarness({ name: 'research-service' })
  .state(durableStateStore)
  .sandbox(bashSandbox({ network: { deny: ['169.254.169.254'] } }))
  .memory(persistentMemory)
  .runtime(durableRuntime)
  .requires(['sandbox.fs', 'sandbox.exec', 'memory.persistent', 'runtime.checkpoint'])
  .models(...)
  .agents(...)
  .build()
```

`.requires(...)` validates adapter capabilities during setup. Use it to fail fast when a required sandbox, memory, or runtime capability is missing.

## Streaming
Harness stream methods return typed `RunEvent` values:

```ts
for await (const event of session.agents.triage.stream(input)) {
  if (event.type === 'tool.started') console.log(event.toolId)
  if (event.type === 'model.delta') process.stdout.write(event.delta)
}
```

Do not treat harness streams as a client HTTP protocol. Map `RunEvent` into application-owned SSE, WebSocket, or queue events at the integration edge.

## Shutdown
Close session and harness resources:

```ts
await session.close()
const shutdown = await harness.shutdown()
if (shutdown.errors.length) logger.error('Harness shutdown errors.', { errors: shutdown.errors })
```

Provider clients, MCP runners, state stores, and sandboxes may own resources that need shutdown.
