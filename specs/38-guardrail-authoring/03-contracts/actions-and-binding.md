# Action authoring and attachment

## CTR-GA-ACTIONS

Replace publicly executable action objects with `defineGuardrailAction(definition) -> GuardrailAction<P>`. The result is an opaque immutable token with public readonly literal `phase: P`; it exposes no evaluator or protected-value generic. Its private brand prevents structural forgery. A private WeakMap owns prepared execution data. `GuardrailActions` remains a readonly string-keyed record of these covariant phase tokens, so heterogeneous narrow actions coexist without `any`, `Function`, or bivariant method escape hatches. Unknown/forged tokens fail configuration validation, including JavaScript callers.

Export `GuardrailActionDefinition<P extends GuardrailPhase = GuardrailPhase, Schema extends z.ZodTypeAny | undefined = undefined, CanTransform extends boolean = true>` and `GuardrailEvaluator<P extends GuardrailPhase = GuardrailPhase, V = GuardrailValue<P>, CanTransform extends boolean = true>` for extracted callbacks; derive the evaluator from the definition contract, not a second context. Defaults are true, never boolean. The helper has exactly four cases: schema-present/absent crossed with literal false versus true-or-omitted. Callback annotations cannot widen inferred phase/schema: use NoInfer on callback-dependent parameters. With a schema, value is `z.output<Schema>` constrained to the phase's JSON domain; without one, value is the existing `GuardrailValue<P>`. Narrow values require a schema. `mayTransform: false` admits only allow/block; omitted or literal true admits phase-specific transform. A dynamic boolean or explicit boolean generic is rejected until the caller narrows it. No broad boolean/default generic branch may re-enable transforms. Use distributive phase typing and function-property evaluate; wrong transform targets must fail for inline/helper/default-generic authoring, not only explicitly annotated examples.

Definition fields are exactly `phase`, optional `valueSchema`, optional `timeoutMs`, optional `mayTransform`, `evaluate`, optional `tools` for tool phases, and optional `models` as below. `tools` is forbidden for input/output/retrieval. `models` is a readonly array of direct Harness aliases requiring the `object` capability; omitted means none. The model handles exposed to a callback are projected to these declared aliases only; direct undeclared model access remains a runtime failure, not a static registry proof. `modelCheckRail` declares its own model dependency and uses this helper; no alias indirection remains.

The private adapter validates the protected JSON with the existing shared schema-preservation logic before forming an evaluation thunk that accepts canonical `DecisionExecutionContext`. That thunk closes over the schema-parsed, frozen value, so no unchecked assertion from JSON to V is needed. The coordinator invokes it inside the existing runDecisionOperation callback with that operation's child signal and effective deadline; never capture only the enclosing signal. Structurally unequal parse output fails closed, including defaults, strip/coercion/transform changes. Preserve the original snapshot as the chain's protected value. The existing rail coordinator alone owns evidence, telemetry, timeout/cancellation, `runDecisionOperation`, outcome validation, and transform commit. Preparing a token must not invoke an application callback, detector, model, or extra timer. Outcome validation occurs exactly once against the same schema and spec37 decision contracts.

### Tool selection

`tools` is an optional nonempty unique list of exact configured tool IDs; omit to inspect all tools. No wildcard, regex, provider tool name, predicate, or category expansion. Use the existing canonical resolved tool ID also used by governance. Select before protected-value schema validation, codec extraction, detector/model invocation, or action callback. A nonselected occurrence is skipped without guardrail evaluation events. Configured ordinal remains its position in the phase list, even when other actions are skipped. A selected mismatch fails closed and performs no protected effect. Selection grants no tool permission.

`createSensitiveDataActions({ detector })` returns the six existing input/output/retrieval tokens with literal keys/phases. Remove its `toolInput`/`toolOutput` options and `SensitiveDataToolActionOptions`. Add `sensitiveDataToolRail({ detector, phase, tools, policy, operation, valueSchema, codec })`: phase is tool_input/tool_output; tools is required nonempty; policy is input/output; operation is detect/mask; valueSchema is required and codec T is its JSON output. Export `SensitiveDataToolRailOptions<P extends 'tool_input' | 'tool_output', Schema extends z.ZodTypeAny>` with no generic defaults; infer both from phase/schema, never from codec callbacks. The returned token is named by its registry key. This replaces the dynamic detectFlow/maskFlow name sub-DSL. It shares detector/policy/codec algorithms with the six-action factory, not copies. Change codec `extract` and `replace` to function properties and use the same schema fence before either callback. String actions declare string schemas; retrieval actions declare arrays of strings. Existing detector port, entity offsets, privacy/failure contracts and detector packages remain unchanged.

## CTR-GA-BINDING

Core exports strict Zod `agentExecutionRequirementsSchema` and derived `AgentExecutionRequirements`:

```ts
// Normative shape; type is inferred from the core schema, not copied verbatim.
type AgentExecutionRequirements = {
  tools?: readonly string[]
  models?: readonly { alias: string; capabilities: readonly ModelCapability[] }[]
}
```

Lists are nonempty when present; IDs are nonempty; duplicate tool IDs and duplicate aliases/capabilities are rejected in caller declarations. Capability values reuse the existing core capability vocabulary. Interceptors gain optional `requirements`; no addon import or guardrail-specific field enters core. Internally compile/deduplicate combined requirements deterministically in interceptor order; models merge by alias and capability union. Conflicting requirements cannot weaken each other.

Extend the existing builder reference validation at `.build()` to validate requirements from each attached interceptor against the completed configured registry. Reuse one internal resolver for the agent's declared custom tools and enabled builtins, including `builtinTools: false` and omitted-default behavior; replace the duplicated default builtin list in the loop with canonical `BUILTIN_TOOL_NAMES`. Requirement tool IDs must be registered and agent-enabled. MCP uses configured alias IDs, not dynamically discovered server names. Model aliases must exist and declare each required capability. Reuse the model capability membership predicate; retain runtime provider validation. Models registered after `.agents()` are supported. Builder/module helper/direct registration paths all reach the same validation.

Build examines declarations only. It opens no session, invokes no model/detector/action, starts no MCP process, and performs no sandbox operation. Runtime `prepareStep`, permissions/governance and adapter capability filtering may narrow tool availability further; build does not prove a tool will be offered or executable on a particular turn. Requirements never enable a tool, add a model, invoke approval, or override restrictions.

`Guardrails.attach` still preserves the exact agent definition's schema and callback inference, appends its interceptor after existing ones, and rejects custom-handler agents. It is a decorator, not the complete registry verification point. Its interceptor requirements are derived from only configured input/output/tool_input/tool_output actions. Retrieval dependencies are excluded. The existing interceptor() remains private; do not create a new public method. Manually authored core interceptors with requirements use the same build validator. Applications must finish `.build()` before accepting requests.

The existing public `filterRetrievedChunks(chunks, context?)` retains its signature and checks the declared object-model dependencies for its retrieval actions against execution-context handles before any retrieval callback; missing/noncallable handles fail configuration validation. It cannot prove adapter capability or reachability beyond the supplied callable interface. There are no tool requirements for retrieval. Do not require unrelated attached-phase dependencies for retrieval and vice versa. No applyRetrieval alias is introduced.

### Honest schema boundary

Attachment/build do not compare arbitrary Zod schemas or claim semantic compatibility. Input rails see parsed agent input (`z.output<I>`); tool_input rails see unparsed wire arguments; tool_output rails see validated tool output; output rails see the final candidate before agent output parsing. A schema is a runtime precondition on that phase's actual JSON, not proof that it includes every value accepted by another schema. Reuse a wire-preserving schema when appropriate; do not reuse a coercing/defaulting tool input schema for a pre-parse rail and expect parsed values. Keep these runtime checks and add tests demonstrating their limit. No public `compatible: true` flag, JSON-schema equality algorithm, generic `V extends agentInput` claim, or unsafe cast is permitted.

## CTR-GA-ERRORS

Reuse `GuardrailsConfigError` for parse/compile/token/standalone dependency failures and `HarnessConfigError` for build requirement failures. Export `guardrailsConfigErrorReasonSchema` and derived `GuardrailsConfigErrorReason`; reasons are `invalid_shape`, `action_missing`, `invalid_action`, `missing_policy`, `unsupported_entity`, `model_missing`, `model_capability_missing`. Export `guardrailsConfigErrorMetaSchema` and derived `GuardrailsConfigErrorMeta` with required reason and only optional field, flowId and modelAlias strings. Constructor becomes `new GuardrailsConfigError(meta: GuardrailsConfigErrorMeta)`; its fixed message is `Guardrails configuration is invalid.` and it accepts no caller message/cause. Preserve code GUARDRAILS_CONFIG_ERROR, config category and retriable false. This replaces, not overloads, the old constructor and flow_id field.

| Condition | Reason |
| --- | --- |
| Shape/unknown field/duplicate flow/policy scalar/invalid timeout/phase mismatch | invalid_shape |
| Configured flow absent from registry | action_missing |
| Forged token, custom-handler attach or malformed callback declaration | invalid_action |
| Required sensitive policy missing | missing_policy |
| Entity not supported by declared detector | unsupported_entity |
| Standalone retrieval declared model absent | model_missing |
| Standalone retrieval model lacks callable object | model_capability_missing |

Build failures use HarnessConfigError with existing `reason: invalid_agent`, path to `agents.<id>.interceptors.<index>.requirements`, and declared offending ID. No configuration source, prompt, matched text, raw Zod issue input, custom exception message or raw cause crosses serialized errors/logs. Paths and field paths are diagnostic only, not metric labels. Invocation failures retain spec37 classes, safe reasonCode handling, telemetry, bounded deadlines and effect ordering unchanged.
