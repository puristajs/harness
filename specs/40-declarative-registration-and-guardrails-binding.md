# Declarative agent/workflow registration and Guardrails binding

**Status:** partially superseded by
[42-clean-builder-and-runtime-api](./42-clean-builder-and-runtime-api.md),
2026-08-30. The repository owner
explicitly requested and auto-approved this refactor, including implementation,
examples, documentation, website, PURISTA integration, and skills. This contract
supersedes agent/workflow callback-helper registration and
`Guardrails.attach(...)` wherever older specifications describe them. Spec 42
generalizes registration to all registry families and replaces its registration
rules; this file remains authoritative for direct Guardrails binding.

## Outcome

Harness definitions read as one fluent registry declaration. A developer uses
the singular method for one entry and the plural method for a cohesive record:

```ts
defineHarness()
  .models(models)
  .agent('classify', classifyAgent)
  .agent('answer', answerAgent)
  .agents(moreAgents)
  .workflow('support', supportWorkflow)
  .workflows(moreWorkflows)
  .build()
```

Every singular and plural call contributes to the same accumulated registry.
There is no builder callback whose only purpose is to return an identity-wrapped
agent or workflow.

## Registration contract

- `agent(id, definition)` registers one agent.
- `agents(definitions)` registers a nonempty record of agents.
- `workflow(id, definition)` registers one workflow.
- `workflows(definitions)` registers a nonempty record of workflows.
- All four methods are repeatable in their valid phase. Singular and plural
  registration use the same normalization, validation, merge, and duplicate-id
  implementation.
- Registry types accumulate across repeated calls. Later workflows see every
  previously registered agent. The built Harness exposes every accumulated
  agent and workflow with its exact schema input/output types.
- Model aliases are declared before agents. Tools and skills used by an agent
  are declared before that agent. Agents used by a workflow are declared before
  that workflow.
- Duplicate IDs fail synchronously with
  `HarnessConfigError{meta.reason:'duplicate_definition'}`. Registration never
  replaces an existing definition.
- Agent/workflow callback helper overloads and the public
  `AgentDefinitionHelpers`/`WorkflowDefinitionHelpers` types are removed. No
  aliases, deprecated overloads, wrappers, migration helpers, or dual behavior
  remain.
- Standalone `defineAgent` and `defineWorkflow` factories remain absent because
  they cannot preserve the builder registry constraints. A reusable definition
  may be a precisely typed object or a static Harness module.

`HarnessModuleBuilder` exposes the same singular/plural agent and workflow
methods. Module contributions use the same registry merge path as direct
builder contributions.

## Direct Guardrails binding

`@purista/harness` owns a provider-neutral optional binding port and does not
depend on `@purista/harness-guardrails`:

```ts
export const agentGuardrailsBinding: unique symbol

export interface AgentGuardrailsBinding {
  readonly [agentGuardrailsBinding]: AgentExecutionInterceptor
}
```

A default-loop agent accepts one optional `guardrails` binding:

```ts
.agents({
  answer: {
    model: 'support',
    input,
    output,
    instructions: 'Answer the support question concisely.',
    guardrails: supportRails,
  },
})
```

The optional `@purista/harness-guardrails` package implements this binding on
the `Guardrails` value returned by `defineGuardrails(...)`. It no longer exports
or documents `Guardrails.attach(...)`.

The builder resolves the binding once during agent registration and appends its
interceptor after explicitly declared `interceptors`. The normal build-time
interceptor requirement validation therefore remains the sole registry
preflight. Guardrails do not add models, enable tools, widen permissions, run a
provider, or invoke an action during registration/build.

`guardrails` and `interceptors` are default-loop-only. A custom-handler agent
cannot declare either at compile time; a malformed JavaScript definition fails
synchronously as `HarnessConfigError{meta.reason:'invalid_agent'}` before a
session, provider, sandbox, MCP process, or action starts. Explicit retrieval
filtering through `filterRetrievedChunks(...)` remains separate and unchanged.

## PURISTA integration

PURISTA continues to depend only on the public `@purista/harness` contract. An
inline Harness agent passed to `setHarnessAgent(...)` may contain
`guardrails: supportRails`; Core forwards the definition without importing the
optional addon. Concrete model providers, Guardrails construction, governance,
sandboxing, and other runtime adapters remain composition-root concerns.

## Acceptance

1. Repeated singular calls, repeated plural calls, and mixed singular/plural
   calls preserve exact agent/workflow keys and schema input/output inference.
2. Workflow handlers see all agents registered before them, including agents
   contributed by singular, plural, and static-module paths.
3. Unknown model/tool/skill/agent references fail typechecking or the existing
   synchronous runtime validation for JavaScript callers.
4. Duplicate IDs fail identically for every registration path.
5. A direct `guardrails` binding protects the same input/output/tool phases and
   validates the same requirements as the removed decorator path.
6. Custom-handler Guardrails/interceptor declarations fail before execution.
7. Repository searches find no callback-helper agent/workflow registration or
   `Guardrails.attach(...)` consumer outside explicit negative compile tests.
8. Public APIs include concise TypeDoc examples; examples, PURISTA integration,
   handbook, website, and skills use the direct clean API.

No persistence, wire format, data migration, provider adapter, governance,
approval, retrieval, or runtime decision-order change is introduced.
