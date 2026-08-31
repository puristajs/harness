# @purista/harness

Self-hosted enterprise agent harness for typed tools, agents, workflows, state,
sandboxing, streaming, and OpenTelemetry instrumentation.

The core package also exports a provider-neutral evaluation substrate:

- `runEvaluation(...)` executes versioned candidates against versioned cases
  and applies named, versioned scorer adapters.
- `scoreEvaluation(...)` applies new scorers to application-owned sanitized
  observations without re-running the task.
- `createDeterministicEvaluationScorer(...)` creates a typed predicate scorer;
  it is also re-exported by `@purista/harness/testing`.

Harness returns per-case results, coverage, and operational aggregates, but
does not persist datasets or observations, host judges, or provide an experiment
product. Cases keep assessment material away from the task callback; scorers
receive it through the observation. Evaluation telemetry is optional and always
content-free. Read the [evaluation guide](../../docs/guides/evaluating-prompts.md)
for the API boundary and the [PURISTA evaluation handbook](https://purista.dev/handbook/harness/test-and-evaluate/)
for methods, recipes, and integrations.

Telemetry defaults to dual GenAI and OpenInference attributes with no content
capture. `InvokeOptions.traceparent` and `tracestate` accept inbound W3C Trace
Context so application traces can parent harness run spans.

Workflows can orchestrate typed child agents with `ctx.agents.<id>(input)`.
Child-agent calls are disabled until a workflow declares `delegation` or the
harness opts in with `defaults.delegation.enabled: true`. Opted-in workflows get
bounded fan-out, agent allowlists, per-agent model alias overrides, and
lineage-rich run events.

For explicit background work, a workflow can use
`ctx.childTasks.start('agent', input)`. Tasks always own private history and
are retrievable by their session owner through
`session.childTasks`, and queue under the configured delegation ceiling. Use
`{ mode: 'continuable' }` for a short in-process task conversation with
serialized `send(...)` turns and an explicit `close()`; durable/restart-safe
work belongs in an application queue/worker integration.

Sandbox sharing is a workflow policy, not an adapter-topology choice. With no
explicit policy, a background task receives a fresh task-run shared partition.
Set `sandbox: { sharing: 'inherit' }` to use the parent partition, `private`
for a child-private partition, or `group` with an approved group id. A child
may detach from shared sandbox state but cannot terminate the parent resource.

Tool-call governance is optional. Configure `.governance(...)` only when an
application needs policy-driven tool exposure, typed domain policies, approval
gates, shadow rollout, audit events, or an adapter to an external policy engine.
For OPA, install the independent `@purista/harness-policy-opa` addon. It owns
the bounded Data API transport and preserves builder-derived tool-input types;
the application still owns identity, least-data mapping, Rego/bundles,
credentials, topology, and decision-log controls. Cedar and AWS Verified
Permissions remain distinct application-owned integrations.

Content rails return allow/block/phase-specific transforms; permissions and
policies can demand approval, and the single `governance.approval` provider
returns approved/rejected for a prepared occurrence. Decisions share bounded
execution and content-free evidence. Durable external waits keep application
review content and execution claim/receipt state outside core. Read the
[decision guide](../../docs/guides/decisions-and-approval.md) and
[tested composition](../../examples/guardrails/README.md).

Use `model.completed` for generative invocation/token accounting, including
direct and nested model calls. Message/object/delta events describe content and
must not be counted again. Current breaking contracts are listed in the
[release notes](../../docs/releases/decision-boundaries.md).

## Sandboxes

Harness has one topology-transparent `Sandbox` lifecycle: each logical
session- or run-scope is opened in `create`, `attach`, or `restore` mode and
returns a detachable client attachment. Provider allocation, generations,
leases, fencing, and resource identifiers stay inside the adapter. An absent
`attach` or `restore` is `SandboxStateLostError`; it is never replaced with an
empty workspace. Durable workspace checkpoint files—not a retained process or
volume—are the recovery guarantee.

Both built-in sandboxes provide bounded, non-backtracking file search through
`sandbox.text_search`; `inMemorySandbox()` needs no shell. Agents opt in with
`builtinTools: ['grep']`, and each result reports whether limits made it
incomplete. Custom Docker, Kubernetes, microVM, and remote adapters implement
the same `searchText(...)` contract where their files live. Missing support
fails at `build()` instead of downloading files or using a hidden fallback.

For trusted single-host Docker Desktop or OrbStack development, install the
independent adapter:

```bash
npm install @purista/harness-sandbox-docker
```

It uses a digest-pinned, caller-prepared image and private Docker volumes. It
does not provide durable-workspace restore or hostile multi-tenant isolation.

See the [evaluation guide](../../docs/guides/evaluating-prompts.md) for the
execution model, scorer boundary, and privacy behavior.

## Static modules and test utilities

Reuse local, typed configuration with a static module. Modules are imported
application code: they are not discovered, downloaded, or hot-reloaded.

```ts
import { defineHarness, defineHarnessModule } from '@purista/harness'

const provider = /* a configured ModelProvider */
const models = defineHarnessModule<{}>()('support.models', {
  register: (builder) => builder.models({
    support: { provider, model: 'gpt-5-mini', capabilities: ['object'] }
  })
})

const harness = defineHarness().use(models).agents({ /* ... */ }).build()
```

`harness.inspect().modules` contains ordered, data-only provenance. Definition
ids compose additively and duplicates fail early. `shutdown()` centrally closes
all configured closable resources exactly once.

For deterministic tests, `@purista/harness/testing` provides an explicit
sanitizer-based recorder, offline replay provider, and explicit diagnostic
invariant runner. These utilities are opt-in and never create production
traffic recording or persistent replay data.

## Install

```bash
npm install @purista/harness
```

Install the schema library chosen by the application. Zod is the default in
examples, but Harness accepts any Standard Schema validator at agent, tool,
workflow, and Guardrail validation boundaries. Default-loop agent output and
TypeScript-tool input additionally need Standard JSON Schema because a model
creates those values. Zod and ArkType satisfy both directly; Valibot needs its
official `@valibot/to-json-schema` wrapper only for those model-facing schemas.
Harness does not re-export Zod or require an application dependency on it.

Optional peer dependencies:

- `@modelcontextprotocol/client` enables MCP stdio/http tools.

## Optional guardrails

`@purista/harness-guardrails` provides inline typed configuration, opaque action rails, direct model-check rails, and explicit retrieval filtering through the Harness interceptor contract. It is intentionally optional so the core runtime remains dependency-light. See the [guardrails guide](../../docs/guides/guardrails.md).
- `just-bash` enables the exec-capable bash sandbox.
- `@opentelemetry/api` connects harness spans to an existing OpenTelemetry
  context.

## Package Format

This package is ESM-only and ships compiled JavaScript plus TypeScript
declarations from `dist/`. Source files, tests, source maps, and local configs
are not included in the published package.
