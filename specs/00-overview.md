# Overview

**Purpose.** `@purista/harness` is a TypeScript-only library for defining and running AI agents and multi-agent workflows in-process. It provides enterprise-grade observability (OpenTelemetry, structured logs, typed errors) with a minimum surface: no HTTP server, no worker daemon, no deployment story. The core package is `@purista/harness` (harness core, in-memory adapters, TS+MCP tools, telemetry, testing helpers). Provider addons are independent packages such as `@purista/harness-openai`, `@purista/harness-anthropic`, `@purista/harness-bedrock`, and `@purista/harness-azure-foundry`.

## Mental model

```
Harness
  ├─ Foundation: telemetry, logging, state, sandbox (FS + exec), memory, durable runtime, durable workspace
  ├─ Models       (alias → provider + capabilities + default settings)
  ├─ Built-in tools (bash, read, write, edit, glob, grep, list — operate on the sandbox)
  ├─ Custom tools (TS+zod, MCP stdio, MCP http)
  ├─ Skills       (directory + SKILL.md frontmatter; mounted at /skills/<name>/ in sandbox)
  ├─ Agents       (input/output schema, allowed tools+skills, permissions, default loop)
  └─ Workflows    (handler with agents context)
```

**Progressive disclosure.** Skills follow the Agent Skills client model: Level 1 — the harness injects only compact metadata (`name`, `description`, location, and optional compatibility) into the system prompt. Level 2 — when the model decides a skill is relevant, it reads `/skills/<name>/SKILL.md` via the built-in `read` tool. Level 3 — supporting files (`scripts/`, `references/`, `assets/`, or any other bundled files) are accessed on demand. The harness never auto-injects skill bodies.

Streaming is an internal concern of the harness (no `stream` foundation port); per-run events flow through an in-process buffered queue.

## Usage shape

The harness is constructed via a chainable `HarnessBuilder`. Each builder method narrows the type of the next, so cross-key references (e.g. `agent.model`, `agent.tools`) are checked at compile time.

```ts
import { z } from 'zod'
import { defineHarness } from '@purista/harness'
import { openai } from '@purista/harness-openai'

export const harness = defineHarness()
  .models({
    fast: { provider: openai({ apiKey: process.env.OPENAI_API_KEY! }), model: 'gpt-4o-mini', capabilities: ['text','object','tool_use'] },
  })
  .tools({
    lookup_user: {
      description: 'Look up a user by id',
      input:  z.object({ id: z.string() }),
      output: z.object({ name: z.string() }),
      handler: async (_ctx, input) => ({ name: 'Alice' }),
    },
  })
  .agents({
    triage: {
      input:  z.object({ message: z.string() }),
      output: z.object({ label: z.enum(['bug','feature','question']) }),
      model: 'fast',
      tools: ['lookup_user'],
      instructions: 'Classify the request.',
    },
  })
  .workflows({
    handle_ticket: {
      input:  z.object({ ticket: z.string() }),
      output: z.object({ resolution: z.string() }),
      handler: async (ctx) => {
        const r = await ctx.agents.triage({ message: ctx.input.ticket })
        return { resolution: r.label }
      },
    },
  })
  .build()

const session = await harness.getSession('user:42')
const out = await session.workflows.handle_ticket.prompt({ ticket: 'cannot login' })
```

The `HarnessBuilder` is the SOLE supported construction path. Standalone `defineAgent`/`defineWorkflow`/`defineTool`/`defineSkill`/`defineModel` definers are NOT exported; only inline-in-builder definitions achieve the cross-key type constraints.

**One session equals one conversation thread.** Apps that need multiple chat threads per user create multiple sessions, e.g. `session_id = \`${userId}:${threadId}\``. Conversation history is stored on the session; the harness does not model thread/conversation as a separate entity in v1. See [11-sessions](./11-sessions.md) §"Conversation history and threads".

## In scope

- Harness configuration via the chainable `HarnessBuilder` (synchronous `defineHarness().…build()`).
- Foundation: telemetry, logging, state store, sandbox (in-memory files-only stub or `just-bash`-backed bash emulator in v1), and memory adapter.
- Model registry (aliases to providers, capability-gated).
- Built-in tools (bash, read, write, edit, glob, grep, list) operating on the sandbox.
- Custom tools: inline TypeScript, MCP stdio, and MCP HTTP.
- Skills: directory + `SKILL.md` frontmatter, mounted at `/skills/<name>/` in the sandbox; progressive disclosure to the model.
- Agents and multi-agent workflows; per-agent permission policy for `bash`/`write`/`edit`.
- Sessions with persisted conversation history (one session = one thread) and pluggable memory via `SessionMemory`; the default `sandboxMemory()` adapter stores session memory in the sandbox.
- Durable runtime checkpoints and durable workspace replay through explicit opt-in adapters. Durable workspace support covers production workspace lifecycle, checkpoint references, retention, encryption, cleanup, quota, and fallback policy surfaces. See [21-durable-workspaces](./21-durable-workspaces.md).
- OpenTelemetry spans, metrics, logs (full enumeration in [14-otel-conventions](./14-otel-conventions.md)).
- Typed error taxonomy (full enumeration in [15-error-catalog](./15-error-catalog.md)).
- Harness-owned AI evaluation primitives: trace-context propagation, run
  summaries, telemetry interop, deterministic local scorer helpers, and prompt
  candidate evaluation helpers. See [19-ai-eval-core](./19-ai-eval-core.md).

## Non-goals

- No HTTP server, RPC layer, gateway, or deployable service.
- No worker process; no daemon; no scheduler.
- No definition bundle format, signed catalog, or remote loading.
- No approval lifecycle, policy engine, or governance hooks.
- No multi-tenant authentication, billing, or quota engine.
- No time-travel debugger or visual replay UI. Durable workspace replay is an adapter contract for resumable execution state, not a debugger product.
- No production/SaaS example apps. Spec-approved private examples may exist
  under `examples/`, with quickstart remaining the minimal entry point.
- No pluggable stream adapter — the streaming generator is internal.
- No Cloudgrid adapter package, Cloudgrid HTTP API, dataset store,
  prompt-version store, or experiment database in this repository.

## Glossary

| Term            | Meaning |
|-----------------|---------|
| Harness         | Result of `defineHarness()...build()`. Owns adapters, registries, factories. |
| HarnessBuilder  | The chainable builder returned by `defineHarness()`. See [13-public-api](./13-public-api.md). |
| Session         | A conversation thread with persisted history and a `SessionMemory` facade. Indexed by user-supplied id. One session = one thread. |
| Run             | A single `prompt`/`stream` invocation. Has its own id, span, lifecycle. |
| Agent           | A unit with typed input/output, an instructions string, and (optionally) a handler. |
| Workflow        | A user-authored handler that orchestrates agents. |
| Tool            | A callable function exposed to a model: built-in (`bash`, `read`, `write`, `edit`, `glob`, `grep`, `list`), TS, MCP stdio, or MCP http. |
| Skill           | A directory containing `SKILL.md` (YAML frontmatter + markdown) plus arbitrary supporting files; mounted at `/skills/<name>/` in the sandbox. |
| Sandbox         | An isolated FS + (optional) shell-exec environment. v1 ships an in-memory files-only stub and a `just-bash`-backed bash emulator. |
| Model alias     | A user-defined string id resolving to `(provider, model name, capabilities, defaults)`. |
| Durable workspace | Production replay workspace state that links runtime checkpoints to persisted sandbox/workspace state through opaque references. |
| Port            | An interface a harness depends on (state, sandbox, memory, durable runtime, durable workspace, model provider). |
| Adapter         | A concrete implementation of a port. Core ships in-memory/default implementations plus the sandbox-backed memory reference adapter; non-core adapters live in independent packages. |
| ULID            | Lexicographically sortable id format. Harness mints `${kind}_${ulid}`. |
| `$infer`        | Phantom value on `Harness` exposing compile-time keys/types of registered models, tools, skills, agents, workflows. |

## Cross-references

- [01-architecture](./01-architecture.md) — package layout and dependency direction.
- [02-harness-config](./02-harness-config.md) — full builder configuration.
- [11-sessions](./11-sessions.md) — conversation history and threads.
- [13-public-api](./13-public-api.md) — authoritative export list and `$infer` namespace.
- [17-implementation-plan](./17-implementation-plan.md) — build order.
- [19-ai-eval-core](./19-ai-eval-core.md) — AI eval core ownership boundary.
- [20-memory-adapters](./20-memory-adapters.md) — pluggable memory adapter contract.
- [21-durable-workspaces](./21-durable-workspaces.md) — durable workspace replay contract.
