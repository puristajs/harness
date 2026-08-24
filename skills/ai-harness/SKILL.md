---
name: ai-harness
description: Use when designing, implementing, configuring, testing, or extending applications built with @purista/harness and its provider adapters, including agents, workflows, tools, skills, models, state, sandbox, telemetry, and custom adapter packages.
---

# AI Harness

## Use This For
Use this skill for work involving `@purista/harness`, `@purista/harness-openai`, or addon packages named `@purista/harness-*`.

## Core Model
`@purista/harness` is a standalone, ESM-only agent runtime. It composes typed model aliases, tools, skills, agents, workflows, state, memory, sandboxing, logging, telemetry, and streaming behind one session API.

Keep these layers separate:
- configuration: `defineHarness()` registers adapters, defaults, models, tools, skills, agents, and workflows
- execution: `harness.getSession(id)` returns typed `session.agents.*` and `session.workflows.*`
- adapter code: provider, state, memory, sandbox, MCP, durable runtime, logger, and telemetry ports
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
- Use inline helper callbacks for agents and workflows: `.agents(({ agent }) => ({ ... }))` and `.workflows(({ workflow }) => ({ ... }))`.
- Child-agent delegation is disabled by default. Any workflow that calls `ctx.agents.<id>(input)` must declare `workflow.delegation`; prefer `delegation.agents` allowlists and document budget/model overrides there.
- Use `ctx.fanOut(...)` for ordered, bounded workflow batches. Use `ctx.childTasks.start(...)` only for workflow-owned isolated background work; task turns queue under the delegation parallel ceiling and never inherit parent history or widen agent permissions.
- `mode: 'continuable'` keeps an isolated in-process task conversation open for explicit `send(...)` turns and `close()`. Do not use it for durable workflow execution or claim cross-process recovery; use an application queue/worker adapter when work must survive a restart.
- Configure `defaults.historyRetention` for durable conversations that need a storage bound. It retains complete newest turns only and requires an atomic `StateStore.replaceMessages`; `maxBytes` is serialized UTF-8 storage size, never a token estimate. Use the model's context window/token tooling separately when selecting request context.
- For at-least-once direct-agent delivery, pass the transport's stable message or delivery id as `InvokeOptions.idempotencyKey`. Replaying the same successful invocation returns its recorded output without a second provider call or transcript; never derive this key from prompt content.
- Use `session.release()` at the end of an idle request to close live sandbox/MCP resources while preserving StateStore-backed history and runs. `session.close()` is destructive: it deletes the session record, history, runs, and persisted events.
- Declare model capabilities truthfully. Capability arrays gate both TypeScript handles and runtime behavior.
- Prefer `object` / `object_stream` for structured generation. Do not use legacy `json` capability names.
- Keep RAG orchestration in application/workflow code. The harness provides embeddings and rerank operations, not vector storage.
- Keep HTTP/SSE protocol mapping outside the harness. Harness streams are typed `RunEvent` values.
- Do not import PURISTA framework packages from harness or harness addon packages.
- Do not leak prompts, documents, tool inputs, or secrets through logs or telemetry. `telemetry({ contentCaptureMode: 'NO_CONTENT' })` is the production default.
- Skills are mounted files, not prompt text. Register directories with `.skills(...)`, allowlist skill ids per agent, keep `read` available for skill-backed agents, and verify `SKILL.md` bodies are not inlined into prompts, logs, traces, or persisted events.
- Prefer `ctx.metrics` for application-owned counters, histograms, and operation durations inside workflow handlers, custom agent handlers, and TypeScript tool handlers. Do not call the low-level `TelemetryShim` directly for app metrics.
- Governance policy is optional and late-bound through `.governance(...)` after
  agents/workflows are declared. Keep simple use cases on per-agent
  permissions; use governance only for composable/audited policy, approval, or
  external policy-pack interoperability.
- A governance approval provider is a synchronous decision for one tool call.
  It is not a durable human-review task: the application owns the review
  record, reviewer identity, UI, expiry, decision persistence, and any
  restart-safe continuation. Do not represent a long-lived review with an
  in-process Promise.
- For sensitive-data rails, keep `@purista/harness-guardrails` provider and
  model-runtime agnostic. Install exactly one detector package at the
  composition root. Use native privacy for its deterministic documented subset;
  use `@purista/harness-guardrails-local-ner` only when local model NER is
  required, then install its optional `@huggingface/transformers` peer, provide
  an absolute pre-provisioned model directory, call `warmup()` during startup,
  and map model labels explicitly. Never add model download, model-registry,
  cloud fallback, local path, model output, or inspected content to YAML, logs,
  errors, spans, metrics, fixtures, or examples. A missing optional peer must
  fail closed with its safe remediation and be observable only through the
  stable sensitive-data failure kind.
- Use `@purista/harness-guardrails` for optional typed default-loop content
  rails. It accepts a documented NeMo-shaped YAML subset, requires
  application-owned actions/model aliases, fails closed, and never loads
  Python, Colang, providers, servers, or vector stores from configuration.
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
  `createSensitiveDataActions({ detector })`. Put only exact
  `rails.config.sensitive_data_detection` policy (entities, mask token, score
  threshold) in YAML; never put endpoints, credentials, language,
  recognizers, provider configuration, or fallback rules there. Use the
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
3. Define Zod schemas at every agent, workflow, and tool boundary.
4. Configure model aliases with model-specific provider options, defaults, and the minimal required capabilities.
5. Attach tools, skill directories, permissions, sandbox, memory, state, runtime requirements, logger, and telemetry explicitly.
6. Decide which state is durable: session history/runs use `StateStore`, session memory uses `MemoryAdapter`, and provider context is transient. Bound durable history with whole-turn retention and bound request context with the model's context/token limits.
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
    historyRetention: { maxTurns: 50, maxBytes: 256_000 }
  })
  .models({
    assistant: {
      provider: openai({ apiKey: process.env.OPENAI_API_KEY! }),
      model: process.env.OPENAI_MODEL ?? 'gpt-5-mini',
      capabilities: ['object', 'tool_use']
    }
  })
  .tools({
    lookup_ticket: {
      description: 'Look up one support ticket by id.',
      input: z.object({ id: z.string() }),
      output: z.object({ status: z.string(), summary: z.string() }),
      handler: async (_ctx, input) => ({ status: 'open', summary: `Ticket ${input.id}` })
    }
  })
  .agents(({ agent }) => ({
    triage: agent({
      model: 'assistant',
      input: z.object({ ticketId: z.string() }),
      output: z.object({ priority: z.enum(['low', 'normal', 'high']), reason: z.string() }),
      builtinTools: false,
      tools: ['lookup_ticket'],
      instructions: 'Use lookup_ticket, then return a validated triage object.'
    })
  }))
  .workflows(({ workflow }) => ({
    triage_ticket: workflow({
      input: z.object({ ticketId: z.string() }),
      output: z.object({ priority: z.string(), reason: z.string() }),
      delegation: { agents: ['triage'] },
      handler: (ctx) => {
        ctx.metrics.counter('support.triage.started', 1)
        return ctx.metrics.duration('support.triage.duration', undefined, () => ctx.agents.triage(ctx.input))
      }
    })
  }))
  .build()

const session = await harness.getSession('tenant-a:user-42')
const result = await session.workflows.triage_ticket.prompt({ ticketId: 'T-123' })
await session.release()
await harness.shutdown()
```

The example's in-memory state store supports atomic history replacement for
local use. Production history retention needs a durable StateStore adapter that
implements `replaceMessages` atomically.

## Read If Needed
- `references/configuration.md` for package setup, builder order, sessions, state, sandbox, runtime capabilities, streaming, and shutdown.
- `references/model-setup.md` for provider aliases, OpenAI setup, defaults, capability-gated model handles, multimodal content, embeddings, and rerank.
- `references/agents-workflows-tools.md` for deciding between agents/workflows and wiring typed tools, permissions, MCP, and skill-mounted agents.
- `references/agents-workflows-tools.md` also covers optional governance policy
  and when to prefer it over simple permissions.
- `references/skills.md` for creating harness skill folders and registering/mounting them correctly.
- `references/sandbox.md` for in-memory/bash sandboxes, filesystem/exec APIs, snapshots, built-in tool risk, and custom sandbox adapters.
- `references/state-sessions-streaming-errors.md` for `StateStore`, session lifecycle, memory/history, run events, error mapping, and replay.
- `references/durable-feedback-operations.md` for durable runtime checkpoints, adapter capabilities, feedback records, readiness, and operational runbooks.
- `references/telemetry-observability.md` for OpenTelemetry setup, `TelemetryShim`, span/metric names, logs, privacy, and adapter context propagation.
- `references/adapters.md` for creating and using provider, state store, memory, sandbox, durable runtime, logger, telemetry, tool/MCP, and addon adapter packages.
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
