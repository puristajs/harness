# PURISTA Agent Harness

Self-hosted TypeScript infrastructure for building provider-neutral LLM agent
systems inside your own application or platform.

The harness gives PURISTA applications a typed runtime boundary for:

- direct agent invocation through `session.agents`;
- workflow orchestration through `session.workflows`;
- provider-neutral text, structured object, multimodal, embedding, and rerank
  model operations;
- TypeScript, built-in, and MCP tools;
- reusable skills;
- state, sandboxing, durable workspace replay, logs, traces, and run events;
- provider-neutral eval helpers for deterministic scorer tests and prompt
  candidate comparison;
- provider adapters for OpenAI, Anthropic, Amazon Bedrock, and Azure AI Foundry.

This repository is not a SaaS product. It is lower-level infrastructure that
application teams embed in services, workers, CLIs, or local tools.

## Mental Model

An **agent** is a typed LLM conversation loop. It prepares messages, calls a
model, executes tool invocations, feeds tool results back into the model,
validates the final output, and emits run events.

A **workflow** is application orchestration around one or more agent
invocations. Workflows sequence or parallelize agents, add deterministic logic,
request human approval, write durable state, and create artifacts.

## Quick Start

```bash
npm install
cp .env.example .env
npm run build
npm test
```

Set `OPENAI_API_KEY` in `.env`; examples default to `OPENAI_MODEL=gpt-5-mini`.

The `examples/quickstart` workspace is the recommended starting point.
`examples/showcase` demonstrates mounted skills, custom TypeScript tools, and
multiple workflows with the OpenAI adapter. `examples/living-wiki-jaeger`
demonstrates a local file-backed research workspace with direct typed agent
invocation, optional typed workflows, SSE run observation, review gates,
artifacts, MCP, and Jaeger tracing. `examples/delm-shared-context` uses the
OpenAI adapter by default to demonstrate a DeLM-inspired decentralized
shared-context pattern with task claiming, admission-gated compact entries,
evidence unfolding, and durable checkpoints.
`examples/modular-support-harness` demonstrates static, typed reusable modules
with application-owned workflows, retry-only context projection, and sanitized
test replay. `examples/workflow-child-tasks` demonstrates credential-free
bounded fan-out, isolated background task lookup, and short continuable task
conversations.

See [docs/getting-started/quickstart.md](docs/getting-started/quickstart.md) for the full walkthrough.

## Verification

```bash
npm run lint
npm run build
npm test
npm run test:coverage
npm run test:types
npm run test:contracts
npm run test:integration
npm run test:failure
```

## Documentation

- Start building
  - [Documentation index](docs/README.md)
  - [Quickstart](docs/getting-started/quickstart.md)
  - [Living Wiki Jaeger example](examples/living-wiki-jaeger/README.md)
- Learn the runtime
  - [Architecture](docs/concepts/architecture.md)
  - [Common scenarios](docs/guides/common-scenarios.md)
- Build and extend
  - [Usage guide](docs/guides/usage.md)
  - [Configuration](docs/guides/configuration.md)
  - [Durable Workspaces](docs/guides/durable-workspaces.md)
  - [Evaluating prompts](docs/guides/evaluating-prompts.md)
  - [MCP tools](docs/guides/mcp-tools.md)
  - [Agent Plugins](docs/guides/agent-plugins.md)
  - [Migrating to AI Harness 2.0](docs/guides/migrating-to-v2.md)
  - [Extending and customizing](docs/guides/extending-and-customizing.md)
  - [Testing](docs/guides/testing.md)
- Operate and review
  - [Operations](docs/operations/README.md)
  - [Security](docs/security/README.md)
  - [Reference](docs/reference/README.md)

## Project Structure

- `packages/harness/` — Core runtime, contracts, ports, builder, sessions, tools, sandbox, telemetry, and test helpers.
- `packages/harness-openai/` — OpenAI model provider adapter.
- `packages/harness-anthropic/` — Anthropic model provider adapter.
- `packages/harness-bedrock/` — Amazon Bedrock model provider adapter.
- `packages/harness-azure-foundry/` — Azure AI Foundry model provider adapter.
- `packages/harness-agent-plugins/` — Agent Plugins v1 inspector and explicit Skills/MCP binding addon.
- `packages/harness-guardrails/` — Optional typed, NeMo-shaped input/output/tool/retrieval guardrails addon and provider-neutral sensitive-data detector port.
- `packages/harness-guardrails-presidio/` — Optional original Presidio Analyzer internal-sidecar adapter and deterministic protocol testing helper.
- `packages/harness-guardrails-native-privacy/` — Optional local Rust/Node-API sensitive-data subset for Node.js and Bun.
- `examples/quickstart/` — Smallest runnable PURISTA harness example.
- `examples/showcase/` — Skills, TypeScript tools, and multiple workflow examples.
- `examples/living-wiki-jaeger/` — Local research workspace with Hono, React/Vite, SSE, artifacts, MCP, and Jaeger.
- `examples/delm-shared-context/` — DeLM-inspired shared-context coordination example for parallel worker workflows.
- `examples/modular-support-harness/` — Static module composition, support workflow ownership, and hermetic replay testing.
- `examples/workflow-child-tasks/` — Bounded fan-out, isolated background tasks, session-owner lookup, and in-process continuables.
- `examples/agent-plugins/` — Inspect, review, digest-pin, and explicitly bind an installed Agent Plugins package.
- `examples/guardrails/` — Deterministic NeMo-shaped guardrails and local sensitive-data example using the Harness test adapter.
- `packages/harness-agent-plugins/README.md` — Agent Plugins inspection, review digest, and explicit Skills/MCP binding example.
- `docs/` — End-user and operator documentation.
- `specs/` — Requirements and design contracts for implementation work.
