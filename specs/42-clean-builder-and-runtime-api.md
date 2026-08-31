# Clean builder and runtime API

**Status:** implemented, 2026-08-30. The repository owner explicitly requested
this refactor and approved the specification before implementation. No
compatibility overloads, deprecated aliases, legacy exports, or migration shims
are part of the result.

This specification supersedes conflicting registration, invocation, session
lifecycle, and handler-context text in specs 00, 02, 07, 08, 09, 10, 11, 13,
16, 25, and 40. Guardrails binding behavior from spec 40 remains unchanged.

## Outcome

The Harness has one registration grammar:

```ts
defineHarness()
  .model('primary', primaryModel)
  .models(moreModels)
  .tool('lookup_order', lookupOrder)
  .tools(moreTools)
  .skill('support-methods', supportMethods)
  .skills(moreSkills)
  .agent('support', supportAgent)
  .agents(moreAgents)
  .workflow('resolve_ticket', resolveTicket)
  .workflows(moreWorkflows)
  .build()
```

- A singular method registers one id and one definition.
- A plural method registers a record of definitions.
- Singular and plural calls are repeatable and append to the same immutable
  registry.
- Duplicate ids fail synchronously with
  `HarnessConfigError{meta.reason:'duplicate_definition'}`.
- Registration never replaces an earlier definition.
- Static modules expose the same ten registry methods and use the same
  validation and merge implementation.
- Standalone `defineModel`, `defineTool`, `defineSkill`, `defineAgent`, and
  `defineWorkflow` factories remain absent.

Foundation adapters and policy remain single-owner configuration. Repeating
`storage`, `sandbox`, `memory`, `workspace`, or `governance` fails. Logger,
telemetry, defaults, and required-capability replacement semantics are not
changed by this specification.

## Registration order and inference

Registry producers may be interleaved where their definitions do not depend on
later state. A definition must follow every registry entry it references:

- models, tools, and skills precede an agent that names them;
- agents precede a workflow that invokes them;
- governance follows the registries referenced by its typed rules.

The builder uses `const` type parameters and accumulated intersection state so
later definitions retain exact literal ids, schemas, sandbox capabilities,
allowlists, model handles, governance input correlation, and `$infer` results.
JavaScript and deliberately widened TypeScript values receive equivalent final
cross-registry validation during `build()`.

`build()` remains callable on the fluent builder and requires at least one model
alias at runtime. A Harness with no agents or workflows is valid for static
composition and inspection; it has empty typed invoker registries.

## Model and skill registration

`model(id, definition)` and `models(definitions)` accept the existing
`ModelAlias` shape. `skill(id, definition)` and `skills(definitions)` accept the
existing `SkillDefinition` shape. Singular calls delegate to the same internal
registration functions as plural calls.

Model, tool, agent, and workflow ids match `/^[a-z][a-z0-9_]*$/`, contain at
most 64 characters, and reject the reserved `harness_` and `system_` prefixes.
Skill ids retain the Agent Skills name grammar:
`/^(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$/`; the registry key must match the
resolved `SKILL.md` name according to the selected validation mode. Tool/skill
and tool/built-in namespace collisions remain build errors.

## Direct TypeScript tools

Native TypeScript tools are ordinary definitions at the builder boundary:

```ts
.tool('transfer_funds', {
  description: 'Move money between two authorized accounts.',
  input: transferInput,
  output: transferOutput,
  handler: async (ctx, input) => transfer(ctx, input),
})

.tools({
  get_balance: {
    description: 'Read the current account balance.',
    input: balanceInput,
    output: balanceOutput,
    handler: async (ctx, input) => lookupBalance(ctx, input),
  },
})
```

The singular builder method contextually types an inline native definition.
Its input schema determines the handler input, its output schema constrains the
handler result, and the accumulated sandbox capability tuple determines
`ctx.sandbox`. Use plural registration for cohesive records of pre-typed native
definitions, MCP definitions, or a mixed reusable record. TypeScript cannot
derive a callback parameter from sibling schema properties in an arbitrary
generic object literal, so public examples must not imply that an inline plural
record provides the singular method's contextual handler inference.

The callback form `.tools(({ tool }) => ...)` does not exist. The public
`ToolDefinitionHelpers` and `RegisteredTsToolDefinition` types, the private
registration brand, checked-brand mapped types, and their validation path are
removed. Runtime validation instead validates the discriminated tool shape,
required fields, callable handler/adapters, id, schemas at their existing
projection/validation boundaries, and MCP-specific configuration.

The plural native-tool mapped type preserves each pre-typed definition's exact
schemas and proves its sandbox context is compatible with the builder. A
predeclared tool whose handler requires sandbox capabilities not guaranteed by
the current builder is a compile-time error.

## Invocation API

Agents and workflows use the same invocation verbs:

```ts
await session.agents.support.run(input, options)
await session.workflows.resolve_ticket.run(input, options)

for await (const event of session.agents.support.stream(input, options)) {}
for await (const event of session.workflows.resolve_ticket.stream(input, options)) {}
```

`AgentInvoker` and `WorkflowInvoker` expose only `run` and `stream`. The
`prompt` method and all examples, wrappers, tests, and documentation using it
are removed. The outer invocation span is renamed from
`harness.session.prompt` to `harness.session.run`; its attributes and nesting
remain unchanged. Otherwise this is a naming change only: validation, persistence,
idempotency, cancellation, timeout, streaming, and output semantics are
unchanged.

## Session lifecycle

Session lifecycle uses explicit intent:

```ts
await session.release() // release live resources and retain persisted state
await session.destroy() // release resources and delete persisted session state
```

`Session.close()` is removed. `Session.destroy()` has exactly the former
destructive session-close behavior and remains idempotent under the existing
session lifecycle contract. This rename applies only to Harness sessions.
`close()` remains valid for attachment handles, MCP runners, continuable child
tasks, providers, storage adapters, loggers, and local durable bundles where it
means closing or settling that owned resource.

## Handler context consistency

Executable application handlers use `logger`, never `log`:

- `ToolHandlerContext.logger` remains unchanged;
- `WorkflowContext.logger` replaces `WorkflowContext.log`;
- `AgentContext.logger` is added for custom-handler agents;
- `WorkflowContext.telemetry` and `AgentContext.telemetry` expose the same
  Harness-scoped `TelemetryShim` already available to tools;
- `metrics`, `signal`, `runId`, and `sessionId` retain their existing names.

Dynamic instruction callbacks keep `AgentContextMinimal` and are not expanded
with operational logger or telemetry access. Default-loop interceptor contexts
retain their existing `logger` and `telemetry` fields.

## Public surface cleanup

The main package no longer exports `ToolDefinitionHelpers` or
`RegisteredTsToolDefinition`. `ToolsConfig<C>` is the direct authored and
resolved registry type rather than a record requiring an unconstructable
private brand. Internal registration uses one function per registry family;
singular methods wrap a one-entry record and delegate to it. Direct and module
builders must not duplicate validation or normalization logic.

No removed method or type remains in declarations, runtime objects, tests,
examples, documentation, website content, generated API inventories, or skills.
Release notes provide a mechanical migration table, but no runtime or type
compatibility layer.

## PURISTA framework integration

`@purista/core` continues to consume only published provider-neutral Harness
types. Its attached-agent runtime must:

- register required Harness models, tools, skills, local agents, and workflows
  through the clean singular/plural builder methods;
- invoke attached Harness agents and workflows through `run`;
- release idle sessions with `release` and perform explicit deletion through
  `destroy` only where deletion is intended;
- pass the Harness logger and telemetry bindings through the established
  composition-root adapter context;
- preserve all existing queue, stream, idempotency, governance, Guardrails,
  sandbox, workspace, storage, and error behavior.

CLI templates, generated application code, Core tests, TypeDoc Harness input,
the public PURISTA skill catalog, installed/mirrored skills, and handbook pages
must use the same API.

## Acceptance

1. Singular, plural, repeated, mixed, and static-module registration preserves
   exact keys and schema/context types for all five registry families.
2. Duplicate ids fail identically for singular, plural, mixed, direct, and
   module paths.
3. Invalid and reserved ids fail synchronously for every registry family using
   its specified grammar.
4. Singular inline native tool handlers infer exact parsed input, constrain
   output, and expose only guaranteed sandbox operations; plural registration
   preserves those properties for pre-typed definitions and rejects an
   incompatible sandbox context.
5. Native and MCP tools can coexist in one plural record without type erasure.
6. No callback helper, registration brand, legacy export, `prompt` invoker,
   destructive session `close`, or workflow `log` context remains.
7. Runtime and type tests cover all replacements and negative capability cases.
8. Every maintained example and package compiles against the clean API.
9. Standalone Harness docs, website handbook, generated API evidence, Harness
   skill, PURISTA framework docs/skill, CLI templates, and Core integration are
   migrated end to end.
10. Package-boundary, TypeScript, lint, unit, documentation, website, skill,
    and knowledge audits pass with repository-appropriate commands.

## Implementation evidence

- Harness TypeScript, lint, architecture, Standard Schema, and public type
  contracts pass with `npm run typecheck`, `npm run lint`,
  `npm run verify:architecture`, `npm run verify:standard-schema`, and
  `npm run test:types`.
- The complete Harness workspace test run passes, including all maintained
  adapters and examples. The core runtime contributes 1,045 passing tests.
- PURISTA Core compiles and passes its complete package suite: 88 test files and
  403 tests.
- The public website builds 1,900 pages; handbook, API-documentation, internal
  link, skill, and public-knowledge audits pass.
- Source scans retain the removed names only in this migration contract,
  negative type/audit fixtures, and the distinct `SandboxSession` or child-task
  lifecycle APIs where `close()` remains intentional.

## Mechanical migration

| Removed | Replacement |
| --- | --- |
| `.models({ id: definition })` for one entry | `.model('id', definition)` |
| `.tools(({ tool }) => ({ id: tool(definition) }))` | `.tool('id', definition)` |
| `.tools(({ tool }) => ({ ... }))` | `.tools({ ... })` |
| `.skills({ id: definition })` for one entry | `.skill('id', definition)` |
| `invoker.prompt(input, options)` | `invoker.run(input, options)` |
| `session.close()` for deletion | `session.destroy()` |
| `workflowContext.log` | `workflowContext.logger` |
| `ToolDefinitionHelpers` / `RegisteredTsToolDefinition` | direct `ToolDefinition` / `ToolsConfig` |
