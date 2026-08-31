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
- provider adapters for OpenAI and OpenAI-compatible endpoints, Google Gemini,
  Anthropic, Amazon Bedrock, and Azure AI Foundry.

This repository is not a SaaS product. It is lower-level infrastructure that
application teams embed in services, workers, CLIs, or local tools.

## Mental Model

An **agent** is a typed LLM conversation loop. It prepares messages, calls a
model, executes tool invocations, feeds tool results back into the model,
validates the final output, and emits run events.

A **workflow** is application orchestration around one or more agent
invocations. Workflows sequence or parallelize agents, add deterministic logic,
request human approval, persist durable workflow data, and create artifacts.

## Quick Start

For content safety and tool authority, start with the
[decision table and lifecycle](docs/guides/decisions-and-approval.md). The
[guardrails composition](examples/guardrails/README.md) runs without credentials
and combines input/tool/output rails with one immediate approval provider.
[Durable review](examples/durable-human-review/README.md) keeps wait/claim/receipt
state at the application boundary. See the
[breaking contract notes](docs/releases/decision-boundaries.md).

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
invocation, optional typed workflows, SSE run observation, application-owned review tasks,
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
The [clean builder and runtime API notes](docs/releases/clean-builder-and-runtime-api.md)
describe the intentional Harness 3 breaking surface.

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
  - [Guardrails](docs/guides/guardrails.md)
  - [Decisions and approval](docs/guides/decisions-and-approval.md)
  - [Decision boundary release notes](docs/releases/decision-boundaries.md)
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
- `packages/harness-google/` — Google Gemini API model provider adapter.
- `packages/harness-policy-opa/` — Typed, fail-closed Open Policy Agent Data API governance adapter and strict test fake.
- `packages/harness-storage-postgres/` — Distributed PostgreSQL Harness state, lease, checkpoint, and external-wait adapter.
- `packages/harness-sandbox-kubernetes/` — Self-hosted Kubernetes sandbox with optional PVC/VolumeSnapshot durable workspaces.
- `packages/harness-agent-plugins/` — Agent Plugins v1 inspector and explicit Skills/MCP binding addon.
- `packages/harness-guardrails/` — Optional inline, typed input/output/tool/retrieval guardrails addon and provider-neutral sensitive-data detector port.
- `packages/harness-guardrails-presidio/` — Optional original Presidio Analyzer internal-sidecar adapter and deterministic protocol testing helper.
- `packages/harness-guardrails-native-privacy/` — Optional local Rust/Node-API sensitive-data subset for Node.js and Bun.
- `examples/quickstart/` — Smallest runnable PURISTA harness example.
- `examples/showcase/` — Skills, TypeScript tools, and multiple workflow examples.
- `examples/living-wiki-jaeger/` — Local research workspace with Hono, React/Vite, SSE, artifacts, MCP, and Jaeger.
- `examples/delm-shared-context/` — DeLM-inspired shared-context coordination example for parallel worker workflows.
- `examples/modular-support-harness/` — Static module composition, support workflow ownership, and hermetic replay testing.
- `examples/workflow-child-tasks/` — Bounded fan-out, isolated background tasks, session-owner lookup, and in-process continuables.
- `examples/agent-plugins/` — Inspect, review, digest-pin, and explicitly bind an installed Agent Plugins package.
- `examples/guardrails/` — Deterministic inline guardrails and local sensitive-data example using the Harness test adapter.
- `examples/opa-governance/` — Consumer-shaped real-OPA governance example with deterministic handler-suppression tests.
- `packages/harness-agent-plugins/README.md` — Agent Plugins inspection, review digest, and explicit Skills/MCP binding example.
- `docs/` — End-user and operator documentation.
- `specs/` — Requirements and design contracts for implementation work.
