---
name: ai-harness
description: Use when designing, implementing, configuring, testing, or extending applications built with @purista/harness and its provider adapters, including agents, workflows, tools, skills, models, storage, sandbox, telemetry, and custom adapter packages.
---

# AI Harness

Use this skill for `@purista/harness` applications and first-party `@purista/harness-*` adapters. The Harness is a standalone ESM runtime for typed agents, workflows, tools, skills, model providers, memory, durable storage, sandboxing, governance, and portable execution streams.

## Architecture

Definitions describe behavior and requirements. Runtime bindings supply adapters and credentials:

```ts
const lookup = defineTool('lookup', { description: 'Look up a policy.', input, output, handler })
const assistant = defineAgent('assistant', {
  model: 'primary', input, output, tools: [lookup],
  instructions: 'Use lookup and answer from its result.',
  prompt: value => ({ role: 'user', content: value.question }),
})
const definition = defineHarness({ name: 'support' }).addAgent(assistant)
const instance = await definition.getInstance({
  models: { primary: { provider: openai({ apiKey }), model: 'gpt-5-mini' } },
})
```

Keep these layers separate:

- `defineTool`, `defineSkill`, `defineMcpServer`, `defineAgent`, and `defineWorkflow` create immutable, reusable definitions.
- `defineCatalog` optionally groups trusted definitions for reuse.
- `defineHarness(...).add*()` or `.use(catalog)` composes a typed graph.
- `getInstance(...)` validates and binds the exact runtime resources projected by that graph.
- `getSession(id)` exposes only the composed agents and workflows.
- HTTP, queues, authentication, business data, and UI protocol handling remain application concerns.

## Hard rules

- Use direct definition factories. Do not introduce mutable or string registries, terminal builder calls, compatibility wrappers, or callback-defined agents.
- Put custom orchestration and application code in `defineWorkflow`. An agent is the configurable bounded model loop: instructions, prompt, tools, skills, guardrails, governance, subagents, memory, and sandbox policy.
- Definition ids use lower camel case except Skill ids, which use their manifest-compatible kebab form.
- Pass definition objects in arrays and maps. Do not refer to local tools, agents, workflows, or skills by string.
- Keep providers, secrets, storage clients, memory engines, MCP transports, sandboxes, workspaces, logger, and telemetry in `getInstance(...)`.
- Use model aliases when definitions need different models. Bind the exact aliases through `models`; use singular `model` only for the default `primary` alias.
- A workflow calling an agent declares it in `agents` and invokes `context.agents.name.run(input, { callId })`. Keep every call id stable and unique in the workflow.
- Use `context.step(id, operation)` for durable replay-safe steps. Use `context.externalWait.wait(...)` for persisted human or external decisions.
- Use `HarnessStorage` for sessions, runs, events, checkpoints, and waits; `MemoryEngine` for scoped application memory; `DurableWorkspace` for resumable files. Never substitute a general application state store for these ports.
- Use `run` for one final `RunOutcome`; use `stream` for portable lifecycle and output updates. Build authorized operational views from persisted run summaries, safe telemetry, and application-owned records.
- Use `@purista/harness-ai-sdk-ui/v1` at the server boundary for AI SDK `useChat` or AI Elements. Do not expose raw Harness events as a browser protocol or ship a proprietary browser client.
- Treat approval and external-wait interruptions as expected outcomes. Authenticate and authorize approval decisions in the application before resuming the same run.
- Skills are reviewed mounted directories. A Skill never grants authorization. Scripts run only through explicitly available tools and sandbox capabilities.
- Native TypeScript tools may use typed handler resources. Commands, queues, or framework calls belong behind application-supplied resources, keeping Harness independent of PURISTA Framework packages.
- MCP server definitions contain schemas and remote tool names only. Supply HTTP or stdio transport bindings at instance creation. Stdio requires an isolating spawn-capable sandbox.
- Guardrails inspect or transform model/tool boundaries. Governance decides whether a business operation is allowed, denied, or requires approval. Keep authentication outside both.
- Capture no prompt, tool, document, model output, credential, or policy input in production logs or telemetry. Use `contentCaptureMode: 'NO_CONTENT'`.
- Close the Harness instance during process shutdown. Release an idle session to detach live resources while preserving storage; destroy it only for explicit deletion.

## Default workflow

1. Define schemas with Zod or another Standard Schema implementation. Model-facing structured schemas must also expose JSON Schema.
2. Define tools and skills first, then agents, then workflows.
3. Compose definitions directly or through an immutable catalog.
4. Inspect `definition.requirements` or TypeScript errors to learn the exact runtime bindings.
5. Create one instance with production adapters and safe telemetry.
6. Invoke through a stable session id and handle every terminal outcome.
7. Unit test with `@purista/harness/testing`; add live-provider or infrastructure tests only behind explicit environment gates.
8. Verify public imports, declaration output, cancellation, cleanup, privacy, and deterministic replay where relevant.

## Minimal invocation

```ts
const session = await instance.getSession(`tenant:${tenantId}:chat:${chatId}`, {
  identity: { tenantId, principalId },
})
const result = await session.agents.assistant.run({ question })
if (result.status === 'completed') return result.output
return handleInterrupt(result.interrupt)
```

## References

- [Definitions and composition](references/agents-workflows-tools.md)
- [Runtime configuration](references/configuration.md)
- [Models](references/model-setup.md)
- [Skills](references/skills.md)
- [Storage, sessions, streams, and errors](references/storage-sessions-streaming-errors.md)
- [Sandbox and workspace](references/sandbox.md)
- [Adapters and package surface](references/adapters.md)
- [Durable operations and approvals](references/durable-feedback-operations.md)
- [Telemetry](references/telemetry-observability.md)
- [Testing](references/testing.md)
