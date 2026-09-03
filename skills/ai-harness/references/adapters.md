# Adapter Authoring

## Contents
- Adapter Types And Packages
- Using Adapters
- Model Provider Adapter
- OpenAI-Compatible Provider
- Anthropic Provider
- Amazon Bedrock Provider
- Azure AI Foundry Provider
- Harness Storage Adapter
- Memory Engine
- Sandbox Adapter
- Tool And MCP Adapters
- Durable Workspace Adapter
- Harness Context
- OPA Governance Adapter

Adapters should be thin, typed implementations of harness ports. Prefer official provider SDKs and pass provider-specific options through instead of recreating provider feature matrices inside the harness.

## Adapter Types And Packages

Core ships the common ports, default local adapters, and testing contracts. External adapters belong in independent packages that depend on `@purista/harness` plus their backend SDK only.

| Adapter type | Core port / API | Core default | External package pattern |
| --- | --- | --- | --- |
| Model provider | `ModelProvider` / `BaseModelProvider` | `FakeModelProvider` for tests only | `@purista/harness-openai`, `@purista/harness-anthropic`, `@purista/harness-{provider}` |
| Harness storage | `HarnessStorage` | `InMemoryHarnessStorage`, `SqliteHarnessStorage` | `@purista/harness-storage-{backend}` |
| Memory | `MemoryEngine` | dependency-free `inMemoryMemoryEngine()` | `@purista/harness-memory-{backend}` |
| Sandbox | `Sandbox` / `SandboxSession` | `inMemorySandbox()`, `bashSandbox()` | `@purista/harness-sandbox-{backend}` |
| Durable workspace | `DurableWorkspace` | `InMemoryDurableWorkspace`, `LocalDirectoryWorkspace` | `@purista/harness-workspace-{backend}` |
| Tool adapter | `TsToolDefinition`, MCP stdio/http definitions | built-in tools + TS tools | app-local tools or `@purista/harness-tools-{domain}` |
| Logger/telemetry bridge | `Logger`, `TelemetryShim`, `Metrics` | `JsonLogger`, OTel shim | app-local integration package |
| Governance policy | `GovernancePolicyEvaluator` | Typed native policies | `@purista/harness-policy-opa` for OPA; focused app/addon evaluators for other engines |

Package rules:
- Do not import harness internals from external adapter packages.
- Do not import PURISTA framework packages from harness or harness addon packages.
- Do not make adapter packages depend on each other.
- Keep provider/backend credentials in adapter options or environment-owned app code, not in docs or examples.
- Export one factory with a stable, lowercase adapter id, for example `redisMemory(...)`, `postgresHarnessStorage(...)`, or `remoteSandbox(...)`.

## Using Adapters

Register adapters in the foundation stage before models/agents/workflows:

```ts
const harness = defineHarness()
	.logger(logger)
	.telemetry({ contentCaptureMode: 'NO_CONTENT' })
	.storage(postgresHarnessStorage({ connectionString: process.env.DATABASE_URL! }))
	.sandbox(kubernetesExecution.sandbox)
	.memory(redisMemory({ url: process.env.REDIS_URL! }))
	.workspace(objectStorageWorkspace)
	.requires(['sandbox.fs', 'sandbox.exec', 'memory.persistent', 'storage.multi_instance', 'workspace.persistent'])
	.models({
		/* aliases */
	})
	.agents({
		/* agents */
	})
	.build()
```

Use `.requires([...])` for capabilities the application needs to be correct. Do not silently degrade when a missing capability changes persistence, isolation, durability, or security behavior.

Inside handlers, prefer high-level context helpers over raw adapter access:
- `ctx.models.*` for model calls
- `ctx.memory.application`, `ctx.memory.tenant()`, `ctx.memory.principal()`, `ctx.memory.session`, `ctx.memory.run`, and `ctx.memory.agent` for memory
- `ctx.sandbox` in TypeScript tools for file/exec work
- `ctx.metrics` for application metrics
- `ctx.telemetry` only in adapter/tool internals that need custom spans

## Model Provider Adapter
Prefer extending `BaseModelProvider`:

```ts
import {
	BaseModelProvider,
	toTokenUsage,
	type EmbeddingRequest,
	type EmbeddingResponse,
	type ModelProvider,
	type ObjectRequest,
	type ObjectResponse,
	type RerankRequest,
	type RerankResponse,
	type TextRequest,
	type TextResponse,
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
			usage: toTokenUsage(response.inputTokens, response.outputTokens, response.totalTokens, {
				cachedInputTokens: response.cachedInputTokens,
				cacheCreationInputTokens: response.cacheCreationInputTokens,
				reasoningTokens: response.reasoningTokens,
			}),
			finishReason: 'stop',
			raw: response,
		}
	}

	protected override async doObject<T>(req: ObjectRequest<T>): Promise<ObjectResponse<T>> {
		req.signal.throwIfAborted()
		const response = await this.options.client.generateObject(req)
		return {
			object: response.object,
			usage: response.usage,
			finishReason: 'stop',
			raw: response,
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
- preserve optional cache-read, cache-creation, and reasoning token details
- preserve provider-specific finish/status details in `outcome`
- pass `req.signal` to SDK calls when supported
- pass `req.call.providerOptions` through to provider-specific SDK options
- let `BaseModelProvider` own retry, timeouts, provider error normalization,
  active/deferred retry classification, and retry telemetry
- observe `req.signal` and release SDK resources promptly; the base class
  terminalizes callers even for non-cooperative provider work, but cannot
  force-stop in-process SDK work
- disable hidden official-SDK retry by default when the SDK exposes a stable
  option, unless the user explicitly passes provider-specific retry options
- expose `genAiSystem` for OpenTelemetry semantic conventions
- implement `close()` when the provider owns sockets, child processes, or clients needing shutdown

## OpenAI-Compatible Provider
Use `@purista/harness-openai` for OpenAI or OpenAI-compatible endpoints:

```ts
import { openai } from '@purista/harness-openai'

openai({
	apiKey: process.env.COMPATIBLE_API_KEY!,
	baseURL: process.env.COMPATIBLE_BASE_URL!,
	api: 'chat_completions', // optional: default for compatible endpoints
})
```

The OpenAI adapter supports chat-completions style text/object operations, Responses API text/object operations, and embeddings. `api` defaults to `chat_completions` for OpenAI-compatible endpoints. A compatible endpoint must implement each enabled Chat Completions operation; verify tool calls, streaming, JSON-schema object output, vision, and embeddings separately before declaring them. Use `api: 'responses'` only for OpenAI reasoning models that require `/v1/responses` when function tools and `providerOptions.reasoning_effort` are used. On Chat Completions, `reasoning_effort` is dropped with a warning when tools are present.

The adapter inherits harness logger, telemetry, and model timeout through `BaseModelProvider` unless explicit adapter options override them.

## Google Gemini Provider
Use `@purista/harness-google` for the Google Gemini API:

```ts
import { google } from '@purista/harness-google'

google({ apiKey: process.env.GEMINI_API_KEY! })
```

The Google adapter is a thin `@google/genai` SDK adapter. It maps text,
structured output, application function calls and results, streams, embeddings,
and supported inline multimodal input. It does not expose rerank.
`GoogleFactoryOptions` also accepts the official SDK's Gemini API or
Vertex/enterprise client settings.

## Anthropic Provider
Use `@purista/harness-anthropic` for Anthropic Messages API models:

```ts
import { anthropic } from '@purista/harness-anthropic'

anthropic({
	apiKey: process.env.ANTHROPIC_API_KEY!,
})
```

The Anthropic adapter maps harness messages, tool calls, structured object
generation, and streaming to the official `@anthropic-ai/sdk`.

## Amazon Bedrock Provider
Use `@purista/harness-bedrock` for Amazon Bedrock Runtime Converse models:

```ts
import { bedrock } from '@purista/harness-bedrock'

bedrock({
	region: process.env.AWS_REGION ?? 'us-east-1',
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
	apiKey: process.env.AZURE_AI_API_KEY!,
})
```

The Azure adapter maps chat completions, object generation, streaming, and
embeddings to the official `@azure-rest/ai-inference` client.

## Harness Storage Adapter

Implement `HarnessStorage` for sessions, messages, runs/events, leases,
checkpoints, session locking, and external waits. This port is specific to the
Harness protocol; do not adapt PURISTA's general-purpose `StateStore` or an
unstructured key/value store.

Use the public `HarnessStorage` type and implement its operations against one
transactional backend. Important invariants are:

| Operations | Required behavior |
| --- | --- |
| `getSession`, `upsertSession(record, mode)` | Bind immutable `instanceId`, creation time, and exact optional identity. Required `create` mode inserts only and returns whether it won; `update` requires the matching active instance, never inserts, and returns `false`. |
| `closeSession(id, expectedInstanceId)` | Delete only the matching instance and its owned records; stale closes must leave a newly recreated conversation intact. |
| Message and event operations | Atomic batches, stable ordering, and documented cursor behavior. |
| `acquireRun`, `commitCheckpoint` | Exclusive leases and fenced checkpoint commits; reacquiring an existing attempt reports `resumed` even without a committed checkpoint. |
| Wait operations | Register the wait, change run status, and release its lease atomically; terminal signals are idempotent. |

Keep `createdAt` as an actual timestamp. Never use it as a unique incarnation
identifier or manufacture future timestamps to distinguish rapid recreation.
Advertise only backend guarantees that the implementation enforces.

Adapters must pass `harnessStorageContract` from `@purista/harness/testing`,
plus backend-specific multi-process contention, migration, retention, and outage
tests. Keep message/event ordering stable and storage telemetry content-free.

Use `@purista/harness-storage-postgres` for the first-party distributed path:

```ts
import { postgresHarnessStorage } from '@purista/harness-storage-postgres'

const storage = postgresHarnessStorage({
	connectionString: process.env.DATABASE_URL!,
	leaseTtlMs: 120_000,
})
```

Provide exactly one `connectionString` or caller-owned `pg.Pool`. The adapter
closes only a pool it creates. It lazily applies one versioned migration under
an advisory lock and advertises `storage.persistent` plus
`storage.multi_instance`. PostgreSQL stores Harness sessions, run/checkpoint
coordination, leases, and waits; it does not store memory records, application
review tasks, or workspace files.

## Memory Engine

Implement `MemoryEngine` for a new storage backend. Core creates stable scoped
keys, binds optional tenant/principal identity, validates values and capability
requests, performs optional embedding/summarization model calls, and emits the
standard content-free `harness.memory.*` spans. An engine performs backend I/O
only.

```ts
import type {
	MemoryEngine,
	MemoryEngineContext,
	MemoryListOptions,
	MemoryListResult,
	MemoryRecord,
	MemoryScope,
} from '@purista/harness'

export function redisMemoryEngine(): MemoryEngine<
	readonly ['memory.kv', 'memory.list', 'memory.delete', 'memory.persistent']
> {
	return {
		info: { id: 'redis_memory', packageName: '@myorg/harness-memory-redis' },
		capabilities: ['memory.kv', 'memory.list', 'memory.delete', 'memory.persistent'] as const,
		async get(scope, key, context) {
			context.signal.throwIfAborted()
			return backend.get(scope.scopeKey, key)
		},
		async put(scope, record, context) {
			context.signal.throwIfAborted()
			await backend.put(scope.scopeKey, record)
		},
		async delete(scope, key, context) {
			context.signal.throwIfAborted()
			await backend.delete(scope.scopeKey, key)
		},
		async list(scope, options, context): Promise<MemoryListResult> {
			context.signal.throwIfAborted()
			return backend.list(scope.scopeKey, options)
		},
	}
}
```

Memory engine rules:
- Declare only truthful capabilities: `memory.kv`, `memory.list`, `memory.delete`, `memory.ttl`, `memory.text_search`, `memory.vector_search`, `memory.hybrid_search`, `memory.persistent`, and `memory.multi_instance`.
- Honor `context.signal` on every backend call and preserve `scope.scopeKey` exactly; do not reconstruct identity namespaces.
- Persist the canonical `MemoryRecord`; atomically update its text/vector representation where the backend supports it.
- Reject incompatible vector descriptors/dimensions without automatic reindex or downgrade.
- Never add keys, values, queries, vectors, tenant ids, principal ids, or credentials to logs, attributes, metrics, or errors.
- Keep backend SDKs in the engine package. Core has no database, provider, or embedding-SDK dependency.

Use `memoryEngineContract` and `FakeMemoryEngine` from
`@purista/harness/testing`. Cover scope isolation, cancellation, TTL,
pagination, restart/multi-instance behavior where advertised, descriptor
consistency, and atomic index writes.

## Sandbox Adapter
Implement `Sandbox` and `SandboxSession` for custom isolation:

```ts
const remoteSandbox = {
	capabilities: ['sandbox.fs', 'sandbox.text_search', 'sandbox.exec'],
	async open({ scope, mode, signal }) {
		return {
			session: remoteSession,
			disposition: mode === 'create' ? 'created' : 'attached',
			liveProcessState: 'not_preserved',
		}
	},
	async terminate({ scope, reason, signal }) {
		// Idempotently clean only the provider resources mapped to this scope.
	},
}
```

Make executor availability explicit:
- `executor: 'unavailable'` for filesystem-only sessions
- `executor: 'available'` when `exec(...)` is supported

Text search is a separate capability. To support built-in `grep`, declare
`sandbox.text_search` and expose `searchText(...)` on every opened session.
Validate with `validateSandboxTextSearchRequest(...)`, execute the bounded
literal or `safe_regex_v1` operation where the files live, enforce
`SANDBOX_TEXT_SEARCH_LIMITS`, and report explicit completeness. Safe regex is
case-sensitive with ASCII patterns; literal insensitive mode folds ASCII only.
Do not download
remote workspaces, use JavaScript backtracking regex, interpolate into a shell,
or infer text search from `sandbox.exec`.

Snapshot-capable adapters may implement `snapshot`, `resume`, and `hibernate`, and should declare matching capabilities so applications can fail fast with `.requires([...])`.

The Harness owns stable logical scope; the adapter keeps provider IDs,
generations, leases, fencing and topology private. `attach` and `restore` must
fail with `SandboxStateLostError` when existing state is unavailable—never
silently create a blank replacement. Checkpointed `DurableWorkspace` files are
the recovery promise; retained processes or volumes are optional capabilities.

Use `sandboxContract`, `sandboxTextSearchContract` when advertised, and optional snapshot contract tests from
`@purista/harness/testing`. Shared multi-instance adapters additionally run
`sandboxMultiClientContract`. Cover POSIX absolute path rules, mount semantics,
executor availability, timeout/cancellation, detach, idempotent termination,
and state loss.

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
- Validate every input/output with Standard Schema. Zod is the default example
  library; a TypeScript tool input additionally needs `ModelSchema` Standard
  JSON Schema support, which core projects once at build time.
- Keep tool ids stable and lowercase.
- Put domain-specific logic behind app services; keep the harness tool adapter thin.
- For MCP stdio, ensure the configured sandbox supports `sandbox.spawn`.
- For MCP http, keep authentication in `auth`/headers config and do not log secrets.
- Treat tool arguments and results as content; do not put them in logs or custom telemetry under `NO_CONTENT`.

## Durable Workspace Adapter

Use a `DurableWorkspace` when a recoverable workflow also needs filesystem
snapshots. Run/lease/checkpoint semantics remain in `HarnessStorage`.

```ts
const harness = defineHarness()
  .storage(distributedHarnessStorage)
  .workspace(objectStorageWorkspace)
  .requires(['storage.multi_instance', 'storage.resume', 'workspace.persistent'])
  .models(...)
  .agents(...)
  .build()
```

Streams are observation, not recovery. Recovery resumes from committed checkpoints.

Use `.requires([...])` and `durableWorkspaceContract` so unsupported adapters
fail at startup instead of silently degrading.

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

## OPA Governance Adapter

Use the first-party package rather than rebuilding OPA transport:

```ts
import { createOpaClient, opaPolicy } from '@purista/harness-policy-opa'

const opa = createOpaClient({ baseUrl: process.env.OPA_URL! })

.governance((helpers) => ({
  defaultEffect: 'deny',
  policies: [opaPolicy(helpers, {
    id: 'transfer-policy',
    client: opa,
    decisionPath: ['purista', 'bank', 'transfer', 'decision'],
    mapInput: (ctx) => ctx.toolId === 'transfer_funds'
      ? { amount: ctx.input.amount }
      : undefined,
    resultSchema: opaResultSchema,
    mapDecision: (result) => result.matched
      ? { effect: result.effect, ruleId: result.ruleId }
      : undefined,
  })],
}))
```

Keep the base URL, headers, and path fixed in trusted composition code. Return
`undefined` from `mapInput` to skip an irrelevant tool without I/O. Treat a
successful OPA response without `result` as unmatched and use default deny for
enforcement. `opaPolicy(...)` configures the client with the shared Harness
context and forwards only W3C `traceparent` to that fixed trusted endpoint; it
does not emit policy input/result, URL, headers, or credentials. The strict
fake at `@purista/harness-policy-opa/testing` proves
mapping and handler suppression; it does not evaluate Rego. OPA deployment,
identity, credentials, bundles, health, decision-log masking, and live policy
tests remain application/platform responsibilities. Do not route Cedar or
arbitrary policy services through this client.
