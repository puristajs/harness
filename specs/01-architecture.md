# Architecture

**Status:** active v4 architecture.

## Layers

```text
application definitions
  defineTool / defineMcpServer / defineSkill
  defineAgent / defineWorkflow / defineCatalog
                    ↓
immutable Harness definition and graph compiler
                    ↓
session, run, agent-loop, workflow, and tool orchestration
                    ↓
provider-neutral model, storage, memory, sandbox, workspace,
admission, policy, artifact, logging, and telemetry ports
                    ↓
in-package defaults or separately published adapters
```

The dependency direction is downward. Ports never import orchestrators.
Provider and infrastructure adapters depend only on public Harness ports and
shared helpers. Harness core never imports PURISTA. PURISTA consumes the public
Harness contract and its narrow host-integrator SPI.

Streaming is part of execution and has no separate foundation port or stream
registry.

## Definition graph

Definitions are frozen, identity-bearing values. Agents reference their tools,
Skills, Guardrails, and subagents directly. Workflows reference the agents,
tools, and model requirements they may use. Catalogs package explicit exports
for reuse. A Harness exposes only explicitly selected agent and workflow roots.

Graph compilation:

1. starts from explicit roots;
2. recursively collects their direct-reference dependency closure;
3. validates authentic identities, duplicate ids, model-facing names, schema
   boundaries, requirements, and agent delegation cycles;
4. derives one immutable `RuntimeRequirements` value;
5. creates private per-kind execution indexes.

Those indexes are local implementation details. They are never mutable,
process-global, public string service locators, or capability-granting
registries.

## Definition and runtime separation

Authoring definitions contain schemas, instructions, handlers where the concept
owns a handler, and direct definition references. They contain no live model
provider, credential, queue, storage, memory, sandbox, workspace, MCP
connection, logger, or telemetry instance.

`getInstance` accepts an exact runtime configuration derived from the compiled
requirements. It validates the complete configuration before opening a
resource, then initializes owned resources transactionally. Initialization
failure rolls back in reverse order. `close` is idempotent and closes only
resources owned by the instance.

Definitions can therefore be imported by standalone applications, host
frameworks, tests, catalogs, and contract exporters without initializing
infrastructure.

## Core and addon boundaries

The core package owns:

- immutable definitions, graph compilation, exact inference, and invocation;
- the agent loop, workflow runtime, sessions, streaming, interruption, and
  replay semantics;
- provider-neutral ports and common execution pipelines;
- built-in tools and process-local safe defaults;
- errors, logging, telemetry helpers, contract suites, and testing fakes;
- the narrow host-integrator and adapter-author surfaces.

Focused packages own:

- model-provider SDK adapters;
- production storage, memory, sandbox, and workspace adapters;
- Guardrails and sensitive-data adapters;
- external governance adapters such as OPA;
- Agent Plugin inspection and projection;
- AI SDK UI Message Stream v1 projection.

An addon may import public Harness entry points only. Core has no dependency on
an addon. Optional packages must not register themselves globally or mutate a
Harness definition.

## Package layout

```text
packages/
  harness/
    src/
      definitions/       # identity-bearing factories and contracts
      graph/             # closure compiler and requirement derivation
      runtime/           # instances, sessions, dispatch, replay
      agents/            # standard model loop
      workflows/         # orchestration runtime
      tools/             # built-ins, portable tools, MCP execution
      skills/            # immutable loader and scoped reader
      models/            # provider-neutral invocation and admission
      storage/           # HarnessStorage port and local implementation
      memory/            # MemoryEngine orchestration and local default
      sandbox/           # Sandbox port and local defaults
      governance/        # provider-neutral decisions
      telemetry/
      errors/
      integration/       # narrow host SPI
      adapter/           # narrow adapter-author helpers
      testing/
  harness-<addon>/
examples/
specs/
```

Folders describe ownership, not mandatory filenames. The implementation plan
may refine placement without creating duplicate public concepts or reverse
dependencies.

## Execution boundaries

- Native, built-in, MCP, subagent, and host-aware tools selected by an agent
  pass through the complete validation, decision, approval, timeout,
  cancellation, event, telemetry, and output pipeline.
- Workflow calls to agents always use the target dispatcher. A host integrator
  may route that dispatcher through a distributed transport.
- Direct workflow tool calls reuse the authentic binding, validation, host
  overlay, timeout, cancellation, event, telemetry, and checkpoint stages.
  They deliberately exclude agent-owned exposure, permissions, governance,
  approval, and Guardrails because no agent selected the call.
- Model access is through capability-scoped invokers, never a raw provider
  registry.
- Durable queue delivery is host-owned and explicit. Admission controls
  concurrency but does not provide delivery, retry, or dead-letter semantics.
- Approval is a typed interrupted result. It is never translated into a
  generic runtime error.

## Security and privacy

Definitions grant no authority merely by existing in a graph or catalog.
Agent/workflow allowlists, sandbox ownership, permissions, governance, and
Guardrails are enforced independently.

Prompts, model output, tool input/output, Skill bodies, credentials, headers,
provider continuation, and host invocation context are excluded from
content-free inspection, logs, metrics, and persisted events unless a
deliberate documented content-capture mode permits the specific field.

Host-aware tool context is created per invocation, is not retained in an
instance index or checkpoint, and is never exposed to portable definitions.

## Runtime portability

The package supports modern Node.js and Bun according to package manifests and
CI. Core uses Web-standard APIs where practical. Runtime-specific imports stay
behind adapters. Package entry points are ESM and declaration output must
compile in supported consumer projects without deep imports.

## References

- [42 — complete v4 composition and runtime contract](./42-composable-definitions-and-catalogs.md)
- [13 — public API index](./13-public-api.md)
- [16 — verification contract](./16-testing.md)
- [43 — distributed production reference stack](./43-distributed-production-reference-stack.md)
