# Overview

**Status:** active v4 overview.

`@purista/harness` is a provider-neutral TypeScript library for defining and
running AI agents and workflows either as a standalone library or through a
host framework such as PURISTA. It owns the agent loop, model and tool
boundaries, streaming events, approval interruption, persistence, sandboxing,
memory, telemetry, and typed orchestration contracts. It does not own an HTTP
server, a deployment control plane, authentication, business authorization, or
a client component library.

[Spec 42](./42-composable-definitions-and-catalogs.md) is the detailed owner of
the v4 authoring, composition, inference, runtime, streaming, and host
integration contract. Topic specifications own the runtime behavior linked
from that contract.

## Mental model

Applications define immutable values and connect them with direct references:

```text
tools, MCP servers, and Skills
              ↓
        agents and workflows
              ↓
       optional typed catalogs
              ↓
            Harness
              ↓
       configured runtime instance
```

Definitions contain schemas and behavior. Runtime configuration contains live
providers, credentials, storage, memory, sandbox, workspace, admission, MCP
transport bindings, logging, and telemetry. A capability is available to an
agent or workflow only when its definition references that capability.

The Harness compiler keeps two views:

- executable roots are the agents and workflows explicitly added to a Harness
  or exported by a used catalog;
- the private dependency closure contains everything those roots reference.

Only roots appear in public session invokers and host contracts. A
`defineCatalog(...)` value publicly retains only the definitions explicitly
listed in that authoring catalog, including their original frozen behavior.
The Harness has no public `catalog` or graph property; its recursively compiled
closure remains package-private metadata used for runtime assembly and typed
host checks. Dependency collection never creates a public service locator or
makes a dependency-only target callable.

## Minimal use

```ts
import { defineAgent, defineHarness } from '@purista/harness'
import { openai } from '@purista/harness-openai'

const assistant = defineAgent('assistant', {
  instructions: 'Answer clearly and concisely.',
})

const assistantHarness = defineHarness({ name: 'assistant' })
  .addAgent(assistant)

const runtime = await assistantHarness.getInstance({
  model: {
    provider: openai({ apiKey: process.env.OPENAI_API_KEY! }),
    model: 'gpt-5-mini',
  },
})

const session = await runtime.getSession('conversation-1')
const outcome = await session.agents.assistant.run('How can I reset my PIN?')
await session.release()
await runtime.close()
```

This form defaults to model alias `primary`, string input and output, streaming
text updates, a bounded model loop, process-local storage and memory, and
content-free production telemetry. Adding schemas, tools, Skills, subagents,
Guardrails, workflows, persistence, admission, or custom adapters extends the
same pattern.

One session represents one conversation thread. Applications that offer
several threads create a stable session id for each thread. See
[sessions](./11-sessions.md).

## Capability map

- Immutable factories: `defineTool`, `defineMcpServer`, `defineSkill`,
  `defineAgent`, `defineWorkflow`, `defineCatalog`, and `defineHarness`.
- Composition: `addAgent`, `addWorkflow`, and `use` for catalogs with
  explicit roots.
- Models: text, structured output, embeddings, reranking, image generation,
  speech generation, video generation, and multimodal input through the
  provider-neutral port in [spec 06](./06-models.md).
- Tools: built-in sandbox tools, portable native tools, host-aware tools, and
  explicitly selected MCP tools in [spec 07](./07-tools.md).
- Skills: progressively disclosed Agent Skill directories with explicit runtime
  requirements and read-only mounting in [spec 08](./08-skills.md).
- Agents: configurable model loops with direct tool, Skill, Guardrail, and
  subagent references in [spec 09](./09-agents.md).
- Workflows: typed application orchestration over explicitly declared agents,
  tools, and model capabilities in [spec 10](./10-workflows.md).
- Aggregate and progressive invocation: exact `RunOutcome` and
  `HarnessTargetExecutionEvent` contracts, including typed approval
  interruption and resume, in [spec 42](./42-composable-definitions-and-catalogs.md).
- Storage, durability, sandbox, memory, governance, evaluation, and telemetry:
  the linked topic specifications in [the specification index](./README.md).

## Scope boundaries

Harness core stays independent of PURISTA and provider SDKs. Provider,
storage, memory, sandbox, policy, UI-protocol, and framework integrations live
in focused packages. Core exposes the ports and narrow integrator SPI required
for those packages.

Portable Harness definitions run standalone and in a host. Host-aware tools are
an explicit exception: their definition graph requires the matching host
integrator and cannot be instantiated by the ordinary standalone entry point.

Agent Skills are instruction and resource packages. They do not execute by
being declared. Scripts become executable only through an independently
authorized sandbox operation or a typed tool. The Skill's `allowed-tools`
frontmatter is descriptive and never grants a Harness capability.

Streaming uses Harness events internally. The optional AI SDK UI adapter
projects root events to AI SDK UI Message Stream v1 so existing client
libraries can render text, status, tools, artifacts, and approval flows without
a Harness-specific client library.

## Non-goals

- a global or mutable definition registry;
- public string lookup of tools, agents, workflows, or Skills;
- implicit remote loading, plugin execution, capability discovery, or
  permission grants;
- hidden durable queueing inside `run` or `stream`;
- arbitrary agent handlers or custom agent-loop callbacks;
- an HTTP server, RPC gateway, scheduler, worker daemon, authentication system,
  governance UI, or hosted approval service;
- a vendor-specific model contract or provider-native portable stream format;
- a vector database, business database, or application-domain state model.

## Terms

| Term | Meaning |
| --- | --- |
| Definition | Frozen, branded authoring value with stable identity and schemas. |
| Catalog | Optional immutable package of explicitly exported definitions; it grants no capability by itself. |
| Root | Agent or workflow explicitly exposed by a Harness. |
| Dependency closure | Private recursively collected definitions needed by roots. |
| Harness definition | Immutable compiled definition returned directly by `defineHarness`. |
| Runtime instance | Live providers and adapters bound through `getInstance`. |
| Session | One conversation thread and its scoped runtime invokers. |
| Agent | Configurable provider-neutral model loop. |
| Workflow | Typed application-owned orchestration handler. |
| Tool | Model-callable operation with a validated input/output contract. |
| Skill | Agent Skill directory disclosed progressively to selected agents. |
| Interruption | Typed non-error terminal outcome that requires caller action before resume. |
| Admission | Optional bounded concurrency/rate control, separate from durable queue delivery. |

## Authoritative references

- [42 — composable definitions and catalogs](./42-composable-definitions-and-catalogs.md)
- [01 — architecture](./01-architecture.md)
- [02 — Harness runtime configuration](./02-harness-config.md)
- [13 — public API index](./13-public-api.md)
- [15 — error catalog](./15-error-catalog.md)
- [16 — testing](./16-testing.md)
