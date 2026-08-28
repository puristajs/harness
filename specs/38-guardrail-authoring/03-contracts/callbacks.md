# Harness callback authoring

## CTR-GA-CALLBACKS

Contextual typing is the default for inline callbacks. Extracted callbacks use the canonical owner definition's function-property type or a named alias derived from it. Do not introduce a general `Callback`, `Factory`, `AsyncFunction`, or broad `HarnessFactory` type. An application factory keeps its precise inferred builder/Harness return type; annotate its external dependency parameter once. Function declarations remain permitted for hoisting, generic inference, and established code style. Arrow functions are preferred for extracted callbacks when contextual typing helps, not imposed on every function. Do not make a synchronous factory async without actual asynchronous setup.

Public exported callbacks use function properties, not method syntax chosen to gain bivariance. Adapter class methods that require `this` remain methods. Existing typed provider/storage/detector ports are reused; no wrapper/helper is added merely to change syntax. TSDoc must show inline inference, extracted indexed-access typing, and one schema-transform example.

Replace `AgentDefinitionResolved` and `WorkflowDefinitionResolved` field copies with aliases to the canonical public definitions. Keep their existing omitted-schema string fallback in the conditional helper types. Fix helper/generic signatures rather than casting an inferred definition to a broad `AgentDefinition<BuilderState>` or `Harness<BuilderState>`. No broad interface annotation may erase registered model/tool/agent keys from the factory result.

### Schema directions

| Boundary | Type |
| --- | --- |
| Agent/workflow `prompt`, `stream`, delegation and durable invocation input | `z.input<I>`; omitted schema remains string |
| Agent/workflow handler/instructions/prepareStep/stopWhen context input | `z.output<I>` |
| Native tool handler input and governance prepared input | `z.output<I>` |
| Native tool/custom agent/workflow handler return | `Promise<z.input<O>>` |
| Validated invocation/session/delegation output | `z.output<O>`; omitted schema remains string |

Reuse schema-derived conditional aliases with input/output direction stated in their name. Do not blindly replace every `z.infer`: prepared governance input remains parsed output. The new invocation input aliases must reach `$infer.agents/workflows.*.input`, WorkflowContext.agents, WorkflowChildTasks.start and ContinuableChildTaskHandle.send, which already derive AgentInput/WorkflowInput; do not create parallel durable input types. Existing validation must run once at each boundary; neither typing helpers nor callers pre-parse values to satisfy types. Input/output transforms/defaults get counted regression tests through direct, workflow-delegated and tool calls.

Model-facing native-tool argument and agent output-candidate JSON Schema projections in agents/index.ts use `z.toJSONSchema(schema, { io: 'input' })`, because the model supplies preparse values. Unsupported input-side schemas fail closed through existing errors; no `{}` widening or invented transform interpreter. Verify the actual model request schema and parser counts, not only custom handler paths.

### Native tool inference

The current broad `ToolsConfig` contextualizes native handler input as `any`. Add `ToolDefinitionHelpers<C>.tool<I,O>(definition: TsToolDefinition<I,O,C>): RegisteredTsToolDefinition<I,O,C>`, matching the existing builder-local `agent` and `workflow` helper pattern. `RegisteredTsToolDefinition` is the canonical `TsToolDefinition` intersected with one private registration brand; do not redeclare its fields. A helper callback overload on both `HarnessBuilder.tools` and `HarnessModuleBuilder.tools` supplies the same sandbox-capability-derived C as today. Resolve the callback once; native registration then uses the same implementation as map registration.

Both overloads accept native definitions only from `tool(...)` and normal MCP definitions. Remove the raw native object escape path; a bare native object is a type error and a `HarnessConfigError` with `reason: invalid_tool`, offending registry ID and tools field path. Keep map registration for MCP and already captured registered native definitions. The helper creates a private readonly registration symbol on a shallow copied definition; validate it with an internal type guard at registration. Make the symbol enumerable so supported object spreads/module copies retain it; JSON serialization still omits symbol keys. A symbol preserves reuse across multiple Harness compositions in the same package instance; it is construction evidence, not a security credential or execution permission. No WeakSet, standalone `defineTool` API, dual legacy overload or fallback warning. Module forwarding preserves the brand and exact schemas.

Retain `TsToolDefinition` as the authored definition and `ToolDefinition` as the runtime discriminated union. Do not weaken internal execution contracts merely to store a heterogeneous registry. Public `ToolsConfig` represents accepted registration entries; native members carry the registration brand. Change only the type boundary and validation necessary for helper registration; preserve MCP lifecycle/adapters, sandbox capabilities and runtime tool ordering.

The heterogeneous native registration member is the existing runtime native projection `Extract<ToolDefinition<C>, { kind?: 'ts' }>` intersected with the private brand. Its inherited schema erasure is permitted solely as storage behind generic helper construction; it must never contextualize a user's handler. Both registration overloads additionally validate each inferred entry against its own schemas using a private mapped `CheckedTools<T,C>`: if an entry has input I and output O schemas, require `TsToolDefinition<I,O,C>`; otherwise preserve its MCP member. Accept `T & CheckedTools<T,C>` in the map and helper-callback result. This validates already inferred definitions, rather than attempting the failed raw-object contextual inference approach. Unchanged spreads remain valid; replacing schema/handler incompatibly must fail typechecking. For JavaScript, the symbol proves construction origin only; ordinary input/output runtime schemas still protect invocation. No claim of static safety is made for casts or arbitrary JS mutation.

No new named aliases are added for agent/workflow/tool handlers: use `TsToolDefinition<typeof input, typeof output>['handler']`, `NonNullable<AgentDefinition<S,I,O>['handler']>`, and `WorkflowDefinition<S,I,O>['handler']` when extracting them. Existing `AgentPrepareStep`, `AgentStopWhen`, governance evaluator and approval callback types stay canonical. The new GuardrailEvaluator is owned by CTR-GA-ACTIONS because it combines its phase/schema/transform discrimination.

The existing `examples/living-wiki-jaeger/src/backend/tools.ts` factory receives the builder-supplied ToolDefinitionHelpers as an explicit argument before its existing optional store argument. Wrap its native definitions with tool(...), remove its broad ToolsConfig return annotation and repeated handler input annotations/parses, and keep the precise inferred registry return. Update its harness call site to pass the helper. The boundary already parses input once; no standalone helper, cast, or per-handler revalidation is added to preserve old authoring.

## Acceptance

Both helper and captured-map native registration must infer input fields, defaulted values, handler raw output, exact returned registry keys, and sandbox capabilities without parameter annotations. Unknown input property, wrong output, files-only `.exec`, mismatched extracted context and unregistered raw definitions fail typechecking. Mixed native/MCP and static module registration work. Broad `any`/`unknown` handler input is a failing test, even if a normal positive example compiles. Do not use a guessed raw schema-map overload: the analysis prototype lost contextual inference for mixed MCP registries.
