# Adapter Authoring

## Contents
- Adapter Types And Packages
- Using Adapters
- Model Provider Adapter
- OpenAI-Compatible Provider
- Anthropic Provider
- Amazon Bedrock Provider
- Azure AI Foundry Provider
- State Store Adapter
- Memory Adapter
- Sandbox Adapter
- Tool And MCP Adapters
- Durable Runtime Adapter
- Harness Context

Adapters should be thin, typed implementations of harness ports. Prefer official provider SDKs and pass provider-specific options through instead of recreating provider feature matrices inside the harness.

## Adapter Types And Packages

Core ships the common ports, default local adapters, and testing contracts. External adapters belong in independent packages that depend on `@purista/harness` plus their backend SDK only.

| Adapter type | Core port / API | Core default | External package pattern |
| --- | --- | --- | --- |
| Model provider | `ModelProvider` / `BaseModelProvider` | `FakeModelProvider` for tests only | `@purista/harness-openai`, `@purista/harness-anthropic`, `@purista/harness-{provider}` |
| State store | `StateStore` / `StateStoreAdapterBase` | `InMemoryStateStore` | `@purista/harness-state-{backend}` |
| Memory | `MemoryAdapter` / `MemoryStore` | `sandboxMemory()` | `@purista/harness-memory-{backend}` |
| Sandbox | `Sandbox` / `SandboxSession` | `inMemorySandbox()`, `bashSandbox()` | `@purista/harness-sandbox-{backend}` |
| Durable runtime | `DurableRuntimeAdapter` | none unless implemented by core/test helpers | `@purista/harness-runtime-{backend}` |
| Tool adapter | `TsToolDefinition`, MCP stdio/http definitions | built-in tools + TS tools | app-local tools or `@purista/harness-tools-{domain}` |
| Logger/telemetry bridge | `Logger`, `TelemetryShim`, `Metrics` | `JsonLogger`, OTel shim | app-local integration package |

Package rules:
- Do not import harness internals from external adapter packages.
- Do not import PURISTA framework packages from harness or harness addon packages.
- Do not make adapter packages depend on each other.
- Keep provider/backend credentials in adapter options or environment-owned app code, not in docs or examples.
- Export one factory with a stable, lowercase adapter id, for example `redisMemory(...)`, `postgresStateStore(...)`, or `remoteSandbox(...)`.

## Using Adapters

Register adapters in the foundation stage before models/agents/workflows:

```ts
const harness = defineHarness()
  .logger(logger)
  .telemetry({ contentCaptureMode: 'NO_CONTENT' })
  .state(postgresStateStore({ url: process.env.DATABASE_URL! }))
  .sandbox(remoteSandbox({ endpoint: process.env.SANDBOX_URL! }))
  .memory(redisMemory({ url: process.env.REDIS_URL! }))
  .runtime(durableRuntime)
  .requires(['sandbox.fs', 'sandbox.exec', 'memory.persistent', 'runtime.checkpoint'])
  .models({ /* aliases */ })
  .agents(({ agent }) => ({ /* agents */ }))
  .build()
```

Use `.requires([...])` for capabilities the application needs to be correct. Do not silently degrade when a missing capability changes persistence, isolation, durability, or security behavior.

Inside handlers, prefer high-level context helpers over raw adapter access:
- `ctx.models.*` for model calls
- `ctx.memory.session`, `ctx.memory.run`, `ctx.memory.agent`, `ctx.memory.user()`, `ctx.memory.tenant()` for memory
- `ctx.sandbox` in TypeScript tools for file/exec work
- `ctx.metrics` for application metrics
- `ctx.telemetry` only in adapter/tool internals that need custom spans

## Model Provider Adapter
Prefer extending `BaseModelProvider`:

```ts
import {
  BaseModelProvider,
  type EmbeddingRequest,
  type EmbeddingResponse,
  type ModelProvider,
  type ObjectRequest,
  type ObjectResponse,
  type RerankRequest,
  type RerankResponse,
  type TextRequest,
  type TextResponse
} from '@purista/harness'

export function customProvider(options: CustomOptions): ModelProvider {
  return new CustomProvider(options)
}

class CustomProvider extends BaseModelProvider {
  constructor(private readonly options: CustomOptions) {
    super({ id: 'custom', genAiSystem: 'custom' })
  }

  protected override async doText(req: TextRequest): Promise<TextResponse> {
    req.signal.throwIfAborted()
    const response = await this.options.client.generateText(req)
    return {
      content: response.text,
      usage: { inputTokens: response.inputTokens, outputTokens: response.outputTokens, totalTokens: response.totalTokens },
      finishReason: 'stop',
      raw: response
    }
  }

  protected override async doObject<T>(req: ObjectRequest<T>): Promise<ObjectResponse<T>> {
    req.signal.throwIfAborted()
    const response = await this.options.client.generateObject(req)
    return {
      object: response.object,
      usage: response.usage,
      finishReason: 'stop',
      raw: response
    }
  }
}
```

Implement only supported operations:
- `doText` for `text`
- `doTextStream` for `text_stream`
- `doObject` for `object`
- `doObjectStream` for `object_stream`
- `doEmbed` for `embeddings`
- `doRerank` for `rerank`

If the provider cannot support an operation cleanly, omit it and do not declare the matching alias capability in examples.

Adapter mapping checklist:
- map messages and multimodal `ContentPart` values
- map tool declarations and tool calls
- map schema/object generation
- implement streaming as `AsyncIterable<TextStreamChunk>` / `AsyncIterable<ObjectStreamChunk>` when supported
- implement embeddings and rerank only when the provider API has first-class support
- map token usage and finish reason
- pass `req.signal` to SDK calls when supported
- pass `req.call.providerOptions` through to provider-specific SDK options
- normalize provider errors to `ModelError` / `ModelCapabilityError` through `BaseModelProvider` behavior
- expose `genAiSystem` for OpenTelemetry semantic conventions
- implement `close()` when the provider owns sockets, child processes, or clients needing shutdown

## OpenAI-Compatible Provider
Use `@purista/harness-openai` for OpenAI or OpenAI-compatible endpoints:

```ts
import { openai } from '@purista/harness-openai'

openai({
  apiKey: process.env.OPENAI_API_KEY!,
  baseURL: process.env.OPENAI_BASE_URL,
  organization: process.env.OPENAI_ORG,
  project: process.env.OPENAI_PROJECT
})
```

The OpenAI adapter supports chat-completions style text/object operations and embeddings. Declare only the capabilities the selected model and endpoint support.

The adapter inherits harness logger, telemetry, and model timeout through `BaseModelProvider` unless explicit adapter options override them.

## Anthropic Provider
Use `@purista/harness-anthropic` for Anthropic Messages API models:

```ts
import { anthropic } from '@purista/harness-anthropic'

anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!
})
```

The Anthropic adapter maps harness messages, tool calls, structured object
generation, and streaming to the official `@anthropic-ai/sdk`.

## Amazon Bedrock Provider
Use `@purista/harness-bedrock` for Amazon Bedrock Runtime Converse models:

```ts
import { bedrock } from '@purista/harness-bedrock'

bedrock({
  region: process.env.AWS_REGION ?? 'us-east-1'
})
```

The Bedrock adapter maps harness calls to the official
`@aws-sdk/client-bedrock-runtime` Converse and ConverseStream APIs. AWS
credentials use the standard AWS SDK credential chain.

## Azure AI Foundry Provider
Use `@purista/harness-azure-foundry` for Azure AI Foundry model endpoints:

```ts
import { azureFoundry } from '@purista/harness-azure-foundry'

azureFoundry({
  endpoint: process.env.AZURE_AI_ENDPOINT!,
  apiKey: process.env.AZURE_AI_API_KEY!
})
```

The Azure adapter maps chat completions, object generation, streaming, and
embeddings to the official `@azure-rest/ai-inference` client.

## State Store Adapter
Implement `StateStore` for durable sessions, messages, runs, and streamed events. Extend `StateStoreAdapterBase` when useful so logger, telemetry, and harness name are inherited:

```ts
class PostgresStateStore extends StateStoreAdapterBase {
  async getSession(id) { /* read session */ }
  async upsertSession(record) { /* upsert session */ }
  async appendMessages(sessionId, messages) { /* append atomically */ }
  async listMessages(sessionId, opts) { /* stable ordering */ }
  async createRun(record) { /* insert run */ }
  async finishRun(runId, patch) { /* update terminal run */ }
  async appendEvents(runId, events) { /* append event batch */ }
  async listEvents(runId, opts) { /* cursor/after support */ }
}
```

Durable state stores should pass the state-store contract tests from `@purista/harness/testing`.

State stores may implement `configureHarnessContext(context)` directly or extend `StateStoreAdapterBase`. Keep message and event ordering stable because session history and stream replay rely on deterministic order.

## Memory Adapter
Implement `MemoryAdapter` when a project needs memory outside the default sandbox-backed `sandboxMemory()` adapter. Keep standard validation, spans, metrics, error mapping, and content-capture enforcement in core; adapters implement backend I/O only.

```ts
import type {
  MemoryAdapter,
  MemoryOpenContext,
  MemoryOperationContext,
  MemoryScope,
  MemoryStore
} from '@purista/harness'

export function redisMemory(options: RedisMemoryOptions): MemoryAdapter {
  return new RedisMemoryAdapter(options)
}

class RedisMemoryAdapter implements MemoryAdapter {
  readonly info = {
    id: 'redis_memory',
    packageName: '@purista/harness-memory-redis',
    capabilities: ['memory.kv', 'memory.list', 'memory.delete', 'memory.session', 'memory.user', 'memory.persistent']
  } as const

  configureHarnessContext(context) {
    this.logger ??= context.logger
    this.metrics ??= context.metrics
  }

  async open(scope: MemoryScope, ctx: MemoryOpenContext): Promise<MemoryStore> {
    const prefix = this.scopePrefix(scope)
    return {
      get: (key, op) => this.get(prefix, key, op),
      set: (key, value, op) => this.set(prefix, key, value, op),
      delete: (key, op) => this.delete(prefix, key, op),
      list: (op) => this.list(prefix, op)
    }
  }
}
```

Memory adapter rules:
- Declare exact capabilities: `memory.kv`, `memory.list`, `memory.delete`, `memory.search`, `memory.ttl`, `memory.run`, `memory.session`, `memory.agent`, `memory.user`, `memory.tenant`, `memory.persistent`.
- Honor `ctx.signal` on every backend call.
- Do not emit standard `harness.memory.*` spans or metrics; core wraps facade calls.
- Use `ctx.telemetry` and `ctx.metrics` only for adapter-specific nested spans/metrics.
- Never add raw keys, values, queries, metadata, user ids, or tenant ids to logs/telemetry when `ctx.contentCaptureMode === 'NO_CONTENT'`.
- Throw `HarnessError` instances when you can classify failures; otherwise let core wrap backend failures as memory `StateError`.
- Put Redis/Postgres/vector/graph/product-specific memory adapters in their own TypeScript packages.

Use `memoryAdapterContract` and `FakeMemoryAdapter` from `@purista/harness/testing`. Cover scope isolation, cancellation, unsupported search/TTL gates, persistence behavior, and content-capture modes.

## Sandbox Adapter
Implement `Sandbox` and `SandboxSession` for custom isolation:

```ts
const remoteSandbox = {
  capabilities: ['sandbox.fs', 'sandbox.exec'],
  async open({ sessionId, runId, signal }) {
    return remoteSession
  }
}
```

Make executor availability explicit:
- `executor: 'unavailable'` for filesystem-only sessions
- `executor: 'available'` when `exec(...)` is supported

Snapshot-capable adapters may implement `snapshot`, `resume`, and `hibernate`, and should declare matching capabilities so applications can fail fast with `.requires([...])`.

Use `sandboxContract` and optional snapshot contract tests from `@purista/harness/testing`. Cover POSIX absolute path rules, mount semantics, executor availability, timeout/cancellation, and close idempotency.

## Tool And MCP Adapters
Use TypeScript tools for app-local deterministic capabilities and MCP stdio/http tools for external tool servers.

TypeScript tools can receive inherited context:
- `ctx.logger`
- `ctx.telemetry`
- `ctx.metrics`
- `ctx.memory`
- `ctx.sandbox`
- `ctx.signal`

Tool rules:
- Validate every input/output with Zod.
- Keep tool ids stable and lowercase.
- Put domain-specific logic behind app services; keep the harness tool adapter thin.
- For MCP stdio, ensure the configured sandbox supports `sandbox.exec`.
- For MCP http, keep authentication in `auth`/headers config and do not log secrets.
- Treat tool arguments and results as content; do not put them in logs or custom telemetry under `NO_CONTENT`.

## Durable Runtime Adapter
Use a durable runtime adapter when workflow execution needs leases, checkpoints, retries, and resume behavior:

```ts
const harness = defineHarness()
  .runtime(durableRuntime)
  .requires(['runtime.checkpoint', 'runtime.resume_from_checkpoint'])
  .models(...)
  .agents(...)
  .build()
```

Streams are observation, not recovery. Recovery resumes from committed checkpoints.

Use `.requires([...])` with durable runtime capabilities so unsupported adapters fail at startup instead of silently degrading.

## Harness Context
Adapters that need shared logger, telemetry, timeout defaults, or harness name can implement:

```ts
configureHarnessContext(context) {
  this.logger ??= context.logger
  this.telemetry ??= context.telemetry
  this.metrics ??= context.metrics
  this.harnessName ??= context.harnessName
}
```

The context also carries `contentCaptureMode`. Adapter code must inspect it before adding any backend-specific content to custom spans, metrics, or logs.

Avoid importing application packages in adapters. Adapter packages should depend on `@purista/harness` and their provider/backend SDK only.
