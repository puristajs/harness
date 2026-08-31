# Harness callback authoring

## CTR-GA-CALLBACKS

Contextual typing is the default for inline callbacks. Extracted callbacks use
the canonical owner definition's function-property type or a named alias
derived from it. Do not introduce a general `Callback`, `Factory`,
`AsyncFunction`, or broad `HarnessFactory` type. An application factory keeps
its precise inferred builder/Harness return type; annotate its external
dependency parameter once. Function declarations remain permitted for
hoisting, generic inference, and established code style. Arrow functions are
preferred for extracted callbacks when contextual typing helps, not imposed on
every function. Do not make a synchronous factory async without asynchronous
setup.

Model, tool, skill, agent, and workflow registration uses the direct
singular/plural methods in
[spec 42](../../42-clean-builder-and-runtime-api.md). Identity callbacks,
native-tool helper callbacks, private registration brands, and standalone
definition helpers do not exist.

Public exported callbacks use function properties, not method syntax chosen to
gain bivariance. Adapter class methods that require `this` remain methods.
Existing typed provider/storage/detector ports are reused; no wrapper/helper is
added merely to change syntax. TSDoc must show inline inference, extracted
indexed-access typing, and one schema-transform example.

`AgentDefinitionResolved` and `WorkflowDefinitionResolved` are aliases to the
canonical public definitions rather than copied field shapes. Their omitted-
schema string fallback remains in the conditional helper types. Fix helper and
generic signatures rather than casting an inferred definition to broad
`AgentDefinition<BuilderState>` or `Harness<BuilderState>` values. No broad
interface annotation may erase registered model/tool/agent keys.

### Schema directions

| Boundary | Type |
| --- | --- |
| Agent/workflow `run`, `stream`, delegation and durable invocation input | `z.input<I>`; omitted schema remains string |
| Agent/workflow handler/instructions/prepareStep/stopWhen context input | `z.output<I>` |
| Native tool handler input and governance prepared input | `z.output<I>` |
| Native tool/custom agent/workflow handler return | `Promise<z.input<O>>` |
| Validated invocation/session/delegation output | `z.output<O>`; omitted schema remains string |

Schema-derived conditional aliases state their input/output direction. Prepared
governance input remains parsed output. Invocation input aliases reach
`$infer.agents/workflows.*.input`, `WorkflowContext.agents`,
`WorkflowChildTasks.start`, and `ContinuableChildTaskHandle.send`; no parallel
durable input types are introduced. Validation runs once at each boundary;
typing helpers and callers do not pre-parse values. Input/output transforms and
defaults receive counted regression tests through direct, delegated, and tool
calls.

Model-facing native-tool argument and agent output-candidate JSON Schema
projections use the Standard JSON Schema input direction because the model
supplies pre-parse values. Unsupported input-side schemas fail closed through
existing errors; no `{}` widening or invented transform interpreter is added.

### Native tool inference

`HarnessBuilder.tool` and `HarnessModuleBuilder.tool` contextually type one
native or MCP definition. `tools` accepts cohesive pre-typed native records,
MCP records, and mixed reusable records while checking each native definition
against the builder's sandbox capability context. Both methods delegate to one
structural runtime validator and append-only registry merge.

Inline singular and precisely predeclared native definitions infer parsed input
and raw handler output without parameter annotations. A definition whose
handler requires sandbox capabilities not guaranteed by the current builder is
a type error. Mixed native/MCP records retain exact keys and discriminants.
Public examples use singular registration for inline native definitions because
TypeScript cannot infer a handler parameter from sibling schema properties in
an arbitrary generic object literal.

No new named aliases are added for agent/workflow/tool handlers: use
`TsToolDefinition<typeof input, typeof output>['handler']`,
`NonNullable<AgentDefinition<S,I,O>['handler']>`, and
`WorkflowDefinition<S,I,O>['handler']` when extraction is necessary. Existing
`AgentPrepareStep`, `AgentStopWhen`, governance evaluator, approval callback,
and Guardrail evaluator ownership remain unchanged.

## Acceptance

Singular native registration infers input fields, defaulted values, handler raw
output, exact registry keys, and sandbox capabilities. Plural registration
preserves those properties for pre-typed definitions. Unknown input properties,
wrong output, files-only `.exec`, and mismatched extracted contexts fail
typechecking. Mixed native/MCP and static-module registration work without
casts, identity wrappers, brands, or callback helpers.
