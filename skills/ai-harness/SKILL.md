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

## Hard Rules
- Use `defineHarness()` as the sole construction path. Do not invent standalone `defineAgent`, `defineWorkflow`, `defineTool`, `defineSkill`, or `defineModel` helpers.
- Preserve builder inference by declaring models before agents and agents before workflows.
- Use inline helper callbacks for agents and workflows: `.agents(({ agent }) => ({ ... }))` and `.workflows(({ workflow }) => ({ ... }))`.
- Declare model capabilities truthfully. Capability arrays gate both TypeScript handles and runtime behavior.
- Prefer `object` / `object_stream` for structured generation. Do not use legacy `json` capability names.
- Keep RAG orchestration in application/workflow code. The harness provides embeddings and rerank operations, not vector storage.
- Keep HTTP/SSE protocol mapping outside the harness. Harness streams are typed `RunEvent` values.
- Do not import PURISTA framework packages from harness or harness addon packages.
- Do not leak prompts, documents, tool inputs, or secrets through logs or telemetry. `telemetry({ contentCaptureMode: 'NO_CONTENT' })` is the production default.
- Prefer `ctx.metrics` for application-owned counters, histograms, and operation durations inside workflow handlers, custom agent handlers, and TypeScript tool handlers. Do not call the low-level `TelemetryShim` directly for app metrics.

## Default Workflow
1. Inspect implementation first when behavior matters: `packages/harness/src/harness/defineHarness.ts`, `models/registry.ts`, `agents/index.ts`, `skills/index.ts`, `ports/*`, and provider package source.
2. Decide whether the task is one agent loop, a custom handler agent, or an orchestrating workflow.
3. Define Zod schemas at every agent, workflow, and tool boundary.
4. Configure model aliases with model-specific provider options, defaults, and the minimal required capabilities.
5. Attach tools, skill directories, permissions, sandbox, memory, state, runtime requirements, logger, and telemetry explicitly.
6. Decide how state, history, memory, streaming, errors, security, and operations are handled at the application edge.
7. Invoke through `harness.getSession(id)` and close sessions/harnesses during shutdown.
8. Test with `@purista/harness/testing` fakes/contracts before live-provider smoke tests.

## Quick Pattern
```ts
import { z } from 'zod'
import { defineHarness, JsonLogger, inMemorySandbox } from '@purista/harness'
import { openai } from '@purista/harness-openai'

const harness = defineHarness({ name: 'support-ai' })
  .logger(new JsonLogger({ level: 'info' }))
  .telemetry({ contentCaptureMode: 'NO_CONTENT' })
  .sandbox(inMemorySandbox())
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
      handler: (ctx) => {
        ctx.metrics.counter('support.triage.started', 1)
        return ctx.metrics.duration('support.triage.duration', undefined, () => ctx.agents.triage(ctx.input))
      }
    })
  }))
  .build()

const session = await harness.getSession('tenant-a:user-42')
const result = await session.workflows.triage_ticket.prompt({ ticketId: 'T-123' })
await session.close()
await harness.shutdown()
```

## Read If Needed
- `references/configuration.md` for package setup, builder order, sessions, state, sandbox, runtime capabilities, streaming, and shutdown.
- `references/model-setup.md` for provider aliases, OpenAI setup, defaults, capability-gated model handles, multimodal content, embeddings, and rerank.
- `references/agents-workflows-tools.md` for deciding between agents/workflows and wiring typed tools, permissions, MCP, and skill-mounted agents.
- `references/skills.md` for creating harness skill folders and registering/mounting them correctly.
- `references/sandbox.md` for in-memory/bash sandboxes, filesystem/exec APIs, snapshots, built-in tool risk, and custom sandbox adapters.
- `references/state-sessions-streaming-errors.md` for `StateStore`, session lifecycle, memory/history, run events, error mapping, and replay.
- `references/durable-feedback-operations.md` for durable runtime checkpoints, adapter capabilities, feedback records, readiness, and operational runbooks.
- `references/telemetry-observability.md` for OpenTelemetry setup, `TelemetryShim`, span/metric names, logs, privacy, and adapter context propagation.
- `references/adapters.md` for creating and using provider, state store, memory, sandbox, durable runtime, logger, telemetry, tool/MCP, and addon adapter packages.
- `references/testing.md` for fake providers, type checks, contract tests, and live-provider boundaries.
- `references/package-surface.md` for exports, package boundaries, source files, public docs, and known source-vs-doc checks.
