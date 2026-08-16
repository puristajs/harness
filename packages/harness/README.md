# @purista/harness

Self-hosted enterprise agent harness for typed tools, agents, workflows, state,
sandboxing, streaming, and OpenTelemetry instrumentation.

The core package also exports provider-neutral eval helpers:

- `evaluatePromptCandidates(...)` compares prompt candidates against a fixed
  item set and deterministic or custom scorers.
- `evaluateDeterministicScorer(...)` runs JSON Pointer based deterministic
  scorer definitions without provider calls. It is exported from the main
  package and re-exported from `@purista/harness/testing`.

Telemetry defaults to dual GenAI and OpenInference attributes with no content
capture. `InvokeOptions.traceparent` and `tracestate` accept inbound W3C Trace
Context so application traces can parent harness run spans.

Workflows can orchestrate typed child agents with `ctx.agents.<id>(input)`.
Child-agent calls are disabled until a workflow declares `delegation` or the
harness opts in with `defaults.delegation.enabled: true`. Opted-in workflows get
bounded fan-out, agent allowlists, per-agent model alias overrides, and
lineage-rich run events.

For explicit background work, a workflow can use
`ctx.childTasks.start('agent', input)`. Tasks own an isolated sandbox and
private history, are retrievable by their session owner through
`session.childTasks`, and queue under the configured delegation ceiling. Use
`{ mode: 'continuable' }` for a short in-process task conversation with
serialized `send(...)` turns and an explicit `close()`; durable/restart-safe
work belongs in an application queue/worker integration.

Tool-call governance is optional. Configure `.governance(...)` only when an
application needs policy-driven tool exposure, typed domain policies, approval
gates, shadow rollout, audit events, or an adapter to an external policy engine.

See [Evaluating Prompts](https://github.com/puristajs/harness/blob/main/docs/guides/evaluating-prompts.md)
for the execution model, scorer limits, and privacy behavior.

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

Optional peer dependencies:

- `@modelcontextprotocol/client` enables MCP stdio/http tools.
- `just-bash` enables the exec-capable bash sandbox.
- `@opentelemetry/api` connects harness spans to an existing OpenTelemetry
  context.

## Package Format

This package is ESM-only and ships compiled JavaScript plus TypeScript
declarations from `dist/`. Source files, tests, source maps, and local configs
are not included in the published package.
