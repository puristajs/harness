---
name: ai-harness
description: Use when designing, implementing, configuring, testing, or extending applications built with @purista/harness and its provider adapters, including agents, workflows, tools, skills, models, storage, sandbox, telemetry, and custom adapter packages.
---

# AI Harness

## Use This For
Use this skill for work involving `@purista/harness`, first-party provider
adapters such as `@purista/harness-openai` and `@purista/harness-google`, or
addon packages named `@purista/harness-*`.

## Core Model
`@purista/harness` is a standalone, ESM-only agent runtime. It composes typed model aliases, tools, skills, agents, workflows, Harness storage, memory, sandboxing, logging, telemetry, and streaming behind one session API.

## Response contracts

The public API keeps one explicit final output schema per agent/workflow.
Consumers choose `run` or a portable `stream`; definitions declare whether
`none`, `text-delta`, or `object-snapshot` output updates exist. Provider model
streaming remains a producer/runtime capability and is not forced by the
consumer. The portable successful terminal outcome carries the same validated
output as `run`; interrupt-capable definitions also expose a typed interrupt
outcome. Tool payloads, model messages, governance evidence, and other detailed
events stay on a separately named diagnostic observation surface.

Browser compatibility must use a named, versioned server-side protocol
projection. The first-party adapter supports Vercel AI SDK UI Message
Stream v1 as the only initial GA profile. Keep protocol projection behind a
narrow adapter boundary so another named protocol can be implemented later
without changing Harness execution or PURISTA dispatch. SSE framing alone is
not a protocol, raw `RunEvent` is not a browser contract, and
PURISTA/Harness must not require a proprietary client library. Internal durable
wait signals are converted into public interrupt outcomes and must never become
HTTP 500 responses. Approval interruptions can be projected to standard UI
tool approval states and resumed through application-owned authorization.

Keep these layers separate:
- configuration: `defineHarness()` registers adapters, defaults, models, tools, skills, agents, and workflows
- execution: `harness.getSession(id)` returns typed `session.agents.*` and `session.workflows.*`
- adapter code: provider, Harness storage, memory, durable workspace, sandbox, MCP, logger, and telemetry ports
- application integration: HTTP/SSE, queues, persistence, auth, and business state stay outside the harness unless represented by a port or tool
- optional governance: policy-as-code for tool decisions, approvals, audit, and
  policy-pack adapters is configured only when needed; ordinary agents do not
  require policy setup

## Hard Rules
- Use `defineHarness()` as the sole construction path. Do not invent standalone `defineAgent`, `defineWorkflow`, `defineTool`, `defineSkill`, or `defineModel` helpers.
- Use `defineHarnessModule<Required>()('module.id', { register })` only for local static composition. Modules contribute normal definitions to the caller's builder; they are not remote plugins, manifests, loaders, or lifecycle owners. Module callbacks cannot build or recursively use a harness.
- Use `@purista/harness-agent-plugins` only for data-only Agent Plugins v1 packages. Require application-owned source/digest/trust approval, inspect diagnostics, then bind selected skills and MCP tools explicitly. A selected stdio server also needs an existing caller-owned data directory and an isolating sandbox implementing both `spawn` and `mountReadOnly`; the local host-directory sandbox does not qualify. Never load package code, auto-install dependencies, auto-expose tools, or accept plugin-provided credentials.
- MCP is a clean v2 integration pinned to `2026-07-28`: use `@modelcontextprotocol/client`, modern stateless Streamable HTTP, and a spawn-capable sandbox for stdio. Do not add legacy MCP, HTTP+SSE, one-shot exec, or compatibility fallbacks.
- Module definition ids compose additively. Treat duplicate module/definition ids as configuration errors; inspect only `harness.inspect().modules` for content-free provenance.
- Preserve builder inference by declaring models before agents and agents before workflows.
- Register an inline native TypeScript tool with `.tool(id, definition)` so its
  schemas contextually type the handler. Use `.tools(record)` for cohesive
  pre-typed native batches, MCP definitions, or mixed reusable records. Native
  definitions are ordinary objects; no brand or identity helper exists.
- Register inline definitions with repeatable `.agent(id, definition)` and
  `.workflow(id, definition)`. Use `.agents(record)` and `.workflows(record)`
  for cohesive pre-typed batches. Singular and plural calls accumulate in the
  same registries; duplicate ids are configuration errors. Callback identity
  wrappers are not part of the API.
- Child-agent delegation is disabled by default. Any workflow that calls `ctx.agents.<id>(input)` must declare `workflow.delegation`; prefer `delegation.agents` allowlists and document budget/model overrides there.
- Use `ctx.fanOut(...)` for ordered, bounded workflow batches. Use `ctx.childTasks.start(...)` only for workflow-owned isolated background work; task turns queue under the delegation parallel ceiling and never inherit parent history or widen agent permissions.
- Sandbox sharing is an explicit workflow policy: the default child-task partition is fresh task-run shared state; select `inherit`, `private`, or an application-authorized `group` only when needed. Adapters keep multi-instance allocation, generations, leases, fencing, and provider references private.
- `mode: 'continuable'` keeps an isolated in-process task conversation open for explicit `send(...)` turns and `close()`. Do not use it for durable workflow execution or claim cross-process recovery; use an application queue/worker adapter when work must survive a restart.
- Configure `defaults.historyRetention` for durable conversations that need a storage bound. It retains complete newest turns only and requires an atomic `HarnessStorage.replaceMessages`; `maxBytes` is serialized UTF-8 storage size, never a token estimate. Use the model's context window/token tooling separately when selecting request context.
- For at-least-once direct-agent delivery, pass the transport's stable message or delivery id as `InvokeOptions.idempotencyKey`. Replaying the same successful invocation returns its recorded output without a second provider call or transcript; never derive this key from prompt content.
- Use `session.release()` at the end of an idle request to detach live sandbox/MCP clients while preserving `HarnessStorage`-backed history and runs. `session.destroy()` is destructive: it deletes the session record, history, runs, persisted events, and terminates the session sandbox.
- Declare model capabilities truthfully. Capability arrays gate both TypeScript handles and runtime behavior.
- Prefer `object` / `object_stream` for structured generation. Do not use legacy `json` capability names.
- Keep RAG orchestration in application/workflow code. The harness provides embeddings and rerank operations, not vector storage.
- Keep HTTP/SSE protocol mapping in a dedicated adapter. Public execution streams use `ExecutionEvent`; detailed diagnostics use the separate `observe(...)` surface and `RunEvent`.
- Do not import PURISTA framework packages from harness or harness addon packages.
- Use `.storage(HarnessStorage)` as the only Harness persistence boundary. Do not reintroduce `.state(...)`, `.runtime(...)`, `.checkpoints(...)`, `.externalWait(...)`, or `.workspaceStore(...)`; do not adapt PURISTA's unrelated general-purpose `StateStore` into Harness storage.
- Use `.workspace(DurableWorkspace)` only for resumable filesystem/workspace state. Checkpointed files are the recovery guarantee; live processes, containers, and volumes are optional adapter optimizations. Missing `attach`/`restore` state must raise `SandboxStateLostError`, never become an empty replacement. `localDurableExecution(...)` returns exactly `{ storage, sandbox, workspace, close }` and is for local development or a trusted single-host worker, not distributed production.
- Register direct sandbox owners through the application-authorized `SandboxAdministration` boundary. Perform bounded, exact cleanup/offboarding there; do not leak provider references, owner identities, cursors, snapshots, or file data into telemetry/logs.
- Built-in `grep` requires `sandbox.text_search`, not `sandbox.exec`. The default sandboxes satisfy it with bounded non-backtracking search. A custom adapter must implement data-local `searchText(...)`, validate the request at its boundary, return explicit completeness, and pass `sandboxTextSearchContract`; never add core-side file-read, JavaScript `RegExp`, shell, or compatibility fallbacks.
- Do not leak prompts, documents, tool inputs, or secrets through logs or telemetry. `telemetry({ contentCaptureMode: 'NO_CONTENT' })` is the production default.
- Built-in tools are disabled by default. Omit `builtinTools` for agents that
  need none; use a canonical-name allowlist for every file or process
  capability. Never rely on a skill or custom-tool declaration to widen it.
- Skills are mounted files, not prompt text. Register reviewed directories with
  `.skills(...)`, allowlist skill ids per agent, and explicitly add
  `builtinTools: ['read']` for a default-loop skill agent. Missing `read`
  must fail during agent registration. Treat `allowed-tools` as unenforced
  metadata. Skill instructions and resources are untrusted for authorization;
  scripts are mounted but never auto-executed, and require a separately exposed
  execution-capable tool plus an appropriate sandbox.
- Prefer `ctx.metrics` for application-owned counters, histograms, and operation durations inside workflow handlers, custom agent handlers, and TypeScript tool handlers. Do not call the low-level `TelemetryShim` directly for app metrics.
- Governance policy is optional and late-bound through `.governance(...)` after
  agents/workflows are declared. Keep simple use cases on per-agent
  permissions; use governance only for composable/audited policy, approval, or
  external policy-pack interoperability.
- Use `@purista/harness-policy-opa` for OPA's stable Data API. Construct a
  fixed-base-URL `createOpaClient(...)`, pass the `.governance(...)` helpers to
  `opaPolicy(helpers, ...)`, explicitly minimize the correlated tool context,
  validate the OPA `result` with Standard Schema, and map it to the closed
  Harness decision. The package owns path encoding, one-attempt transport,
  linked cancellation/deadline, bounded response parsing, undefined decisions,
  content-free failures, and automatic active-trace propagation of only W3C
  `traceparent` to the fixed trusted endpoint. The application still owns authenticated identity,
  resource mapping, credentials, Rego/bundles, rollout, decision-log controls,
  and a live-engine test. `adapter(...)` alone still performs no I/O. Cedar and
  AWS Verified Permissions remain separate application-owned evaluator
  topologies; do not hide them or arbitrary URLs behind a generic HTTP adapter.
- `require_approval` suspends the run before any gated tool executes and returns
  a durable `ToolApprovalInterrupt`. The application owns authentication,
  reviewer UI, expiry, and review records, then continues the same run with a
  `ToolApprovalResume`. Treat the interrupt as an expected run outcome, not as
  an application error. The internal `ToolApprovalPendingError` is runtime
  control flow and must never cross the public boundary.
- Use `@purista/harness-ai-sdk-ui/v1` when a web client speaks AI SDK UI Message
  Stream v1. Keep the wire projection in the transport adapter so another
  protocol version can be added without changing agents, workflows, or stored
  approval state.
- Content actions declare their phase and return allow/block/phase-specific
  transform. `afterModel` allows/blocks after `model.completed` accounting;
  `beforeOutput`/output rails transform only the final candidate. Whole-batch
  preflight precedes dispatch; tool schemas/adapters prepare input once before
  permission/policy/approval, and output validation precedes tool-output rails.
  Preserve safe `DecisionEvidence`; never serialize approval subjects or raw
  callback errors. Use `model.completed`, not content events, for generative
  accounting. Direct model calls/custom handlers are not automatically railed;
  opaque reasoning cannot be inspected or rewritten. Admitted effects cannot
  be revoked or rolled back by a later rail.
- For sensitive-data rails, keep `@purista/harness-guardrails` provider and
  model-runtime agnostic. Install exactly one detector package at the
  composition root. Use native privacy for its deterministic documented subset;
  use `@purista/harness-guardrails-local-ner` only when local model NER is
  required, then install its optional `@huggingface/transformers` peer, provide
  an absolute pre-provisioned model directory, call `warmup()` during startup,
  and map model labels explicitly. Never add model download, model-registry,
  cloud fallback, local path, model output, or inspected content to configuration,
  logs,
  errors, spans, metrics, fixtures, or examples. A missing optional peer must
  fail closed with its safe remediation and be observable only through the
  stable sensitive-data failure kind.
- Use `@purista/harness-guardrails` for optional typed default-loop content
  rails. Configure its one inline TypeScript object with opaque action tokens,
  direct registered model aliases, and nonempty explicit selectors for
  tool-input/tool-output actions. It fails closed and never loads providers,
  servers, or vector stores. Bind the configured instance directly with the
  agent definition's `guardrails` field. Do not wrap definitions in a decorator
  or attach call. Custom-handler agents cannot use `guardrails`, interceptors,
  or other default-loop controls.
- Treat every guardrail evaluation as an operational security decision: use
  its content-free `GUARDRAIL` span, outcome metric, and structured decision
  log; blocks are expected enforcement decisions rather than span errors.
  For application-owned retrieval, call `filterRetrievedChunks(chunks, {
  models, signal, logger })` so model checks, cancellation, and audit context
  remain connected to the active workflow.
- A `modelCheckRail` must use a configured Harness model handle. Its nested
  standard `LLM` span—not the GUARDRAIL parent—is the single source of truth
  for model/provider identity and reported `gen_ai.usage.*` /
  `llm.token_count.*` cost inputs.
- For sensitive data, use the provider-neutral `SensitiveDataDetector` port
  exported by `@purista/harness-guardrails` and bind it with
  `createSensitiveDataActions({ detector })`. Put exact inline `sensitiveData`
  policy (`entities`, `maskToken`, `scoreThreshold`) beside its selected flows;
  never put endpoints, credentials, language, recognizers, provider
  configuration, or fallback rules in a rail policy. Use the
  optional Presidio adapter for an application-owned authenticated internal
  sidecar, or the optional native Rust/Node-API adapter for its documented
  local subset. Both must fail closed. In user-facing material, describe them
  with the outcome-oriented capability matrix: Presidio availability is
  deployment recognizer/model dependent; native supports only its documented
  regex/validator subset (including syntax-validated IPv4 and IPv6). Do not
  imply Presidio
  Anonymizer, fake-value generation, hashing/encryption, structured-data,
  image/PDF OCR, or batch support from the detection adapter.
- Sensitive-data inspection has a nested content-free
  `harness.sensitive_data.inspect` GUARDRAIL span and inspection/duration
  metrics. It is not an LLM call: never add model/token/cost or raw
  text/offset/endpoint/header attributes. Standard nested LLM spans remain the
  only source of reported token/model attribution. For structured tool values,
  require an explicit `SensitiveDataValueCodec`; never recursively inspect all
  strings in arbitrary JSON.
- For deterministic Guardrails tests, use
  `@purista/harness-guardrails/testing`'s `FakeSensitiveDataDetector` to
  script findings, full results, or failures. For Presidio wire-contract tests,
  inject `FakePresidioSidecar.fetch` from
  `@purista/harness-guardrails-presidio/testing`; it scripts HTTP outcomes but
  does not emulate Presidio NLP. Test request records are in-memory only and
  must never be copied to logs, telemetry, snapshots, or production fixtures.

## Default Workflow
1. Inspect implementation first when behavior matters: `packages/harness/src/harness/defineHarness.ts`, `models/registry.ts`, `agents/index.ts`, `skills/index.ts`, `ports/*`, and provider package source.
2. Decide whether the task is one agent loop, a custom handler agent, or an orchestrating workflow.
3. Define Zod schemas by default at every agent, workflow, tool, and Guardrail
   value boundary; any Standard Schema validator is valid. Agent input,
   custom-handler output, tool output, workflow input/output, and Guardrail
   values need only `Schema`. TypeScript-tool input and default-loop agent
   output additionally need Standard JSON Schema (`ModelSchema`) because a
   provider creates those values. Harness projects those schemas once at build
   time as Draft 2020-12 JSON Schema, so never add a provider-specific converter
   or vendor wrapper. ArkType implements both directly; Valibot requires its
   official `@valibot/to-json-schema` wrapper only at the two model-facing
   boundaries.
4. Configure model aliases with model-specific provider options, defaults, and the minimal required capabilities.
5. Attach tools, skill directories, permissions, sandbox, memory, Harness storage, optional durable workspace, requirements, logger, and telemetry explicitly.
6. Decide which data is durable: conversation/run/checkpoint/wait records use `HarnessStorage`; scoped facts and recall use `MemoryEngine` (the dependency-free in-memory engine is the default); durable files use `DurableWorkspace`; provider context is transient. Do not adapt PURISTA's general-purpose `StateStore` into Harness storage.
7. Invoke through `harness.getSession(id)`, release idle sessions, and shut down the shared harness during process shutdown. Use destructive session close only for explicit conversation deletion.
8. Test with `@purista/harness/testing` model/runtime fakes, the Guardrails
   fake detector, and the Presidio scripted sidecar before live-provider or
   live-sidecar smoke tests.
9. For provider-loop regression tests, use the explicit sanitizer recorder and offline replay provider; do not capture production interaction content. Use diagnostic invariants only as explicitly invoked test checks.

## Quick Pattern
```ts
import { z } from 'zod'
import { defineHarness, JsonLogger, inMemorySandbox } from '@purista/harness'
import { openai } from '@purista/harness-openai'

const harness = defineHarness({ name: 'support-ai' })
	.logger(new JsonLogger({ level: 'info' }))
	.telemetry({ contentCaptureMode: 'NO_CONTENT' })
	.sandbox(inMemorySandbox())
	.defaults({
		historyRetention: { maxTurns: 50, maxBytes: 256_000 },
	})
	.models({
		assistant: {
			provider: openai({ apiKey: process.env.OPENAI_API_KEY! }),
			model: process.env.OPENAI_MODEL ?? 'gpt-5-mini',
			capabilities: ['object', 'tool_use'],
		},
	})
	.tool('lookup_ticket', {
			description: 'Look up one support ticket by id.',
			input: z.object({ id: z.string() }),
			output: z.object({ status: z.string(), summary: z.string() }),
			handler: async (_ctx, input) => ({ status: 'open', summary: `Ticket ${input.id}` }),
	})
	.agent('triage', {
		model: 'assistant',
		input: z.object({ ticketId: z.string() }),
		output: z.object({ priority: z.enum(['low', 'normal', 'high']), reason: z.string() }),
		tools: ['lookup_ticket'],
		instructions: 'Use lookup_ticket, then return a validated triage object.',
	})
	.workflow('triage_ticket', {
		input: z.object({ ticketId: z.string() }),
		output: z.object({ priority: z.string(), reason: z.string() }),
		delegation: { agents: ['triage'] },
		handler: ctx => {
			ctx.metrics.counter('support.triage.started', 1)
			return ctx.metrics.duration('support.triage.duration', undefined, () => ctx.agents.triage(ctx.input))
		},
	})
	.build()

const session = await harness.getSession('tenant-a:user-42')
const result = await session.workflows.triage_ticket.run({ ticketId: 'T-123' })
await session.release()
await harness.shutdown()
```

The example's in-memory Harness storage supports atomic history replacement for
local use. Production history retention needs a durable `HarnessStorage` adapter that
implements `replaceMessages` atomically.

## Read If Needed
- `references/configuration.md` for package setup, builder order, sessions, storage, sandbox, workspace capabilities, streaming, and shutdown.
- `references/model-setup.md` for provider aliases, OpenAI setup, defaults, capability-gated model handles, multimodal content, embeddings, and rerank.
- `references/agents-workflows-tools.md` for deciding between agents/workflows and wiring typed tools, permissions, MCP, and skill-mounted agents.
- `references/agents-workflows-tools.md` also covers optional governance policy
  and when to prefer it over simple permissions.
- `references/skills.md` for creating harness skill folders and registering/mounting them correctly.
- `references/sandbox.md` for in-memory/bash sandboxes, filesystem/exec APIs, snapshots, built-in tool risk, and custom sandbox adapters.
- `references/storage-sessions-streaming-errors.md` for `HarnessStorage`, session lifecycle, memory/history, run events, error mapping, and replay.
- `references/durable-feedback-operations.md` for recoverable workflow checkpoints, external waits, workspace capabilities, feedback records, readiness, and operational runbooks.
- `references/telemetry-observability.md` for OpenTelemetry setup, `TelemetryShim`, span/metric names, logs, privacy, and adapter context propagation.
- `references/adapters.md` for creating and using provider, Harness storage, memory, durable workspace, sandbox, logger, telemetry, tool/MCP, and addon adapter packages.
- `references/testing.md` for fake providers, type checks, contract tests, and live-provider boundaries.
- `references/agents-workflows-tools.md` for default-loop interception and the
  optional guardrails addon boundary.
- `references/package-surface.md` for exports, package boundaries, source files, public docs, and known source-vs-doc checks.

## Mirror Maintenance

This directory is the canonical source for the AI Harness agent skill. Sync a
runtime mirror explicitly after changing it, then verify byte-for-byte:

```sh
npm run skills:sync -- /path/to/installed/ai-harness
npm run skills:sync -- --check /path/to/installed/ai-harness
```
