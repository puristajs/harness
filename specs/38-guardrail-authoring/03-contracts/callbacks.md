# Definition callback authoring

## CTR-GA-CALLBACKS

Harness uses direct immutable factories: `defineTool`, `defineAgent`,
`defineWorkflow`, `defineSkill`, and `defineMcpServer`. Reuse across packages is
optional `defineCatalog` composition. There is no callback registration helper,
mutable registry, module builder, terminal compilation step, or structural
definition lookalike. Registration callbacks are absent.

Contextual typing is the default for inline handlers and evaluators. An extracted
callback uses the owning definition field's indexed type or its exported
domain-specific alias. Do not introduce a broad `Callback`, `Factory`,
`AsyncFunction`, or `HarnessFactory`. Public callback fields use function-property
syntax so parameter variance remains sound; adapter class methods that require
`this` remain methods.

Definitions retain their exact schema, literal id, dependency references,
sandbox requirements, response mode, and `$infer` contract. Catalog and Harness
composition preserve those types without widening to `string`, `unknown`, `any`,
or a broad JSON record. Factories validate and freeze their local closed shape
synchronously; graph compilation validates cross-definition requirements before
`getInstance(...)` initializes adapters.

### Schema directions

| Boundary | Type |
| --- | --- |
| Agent/workflow `run`, `stream`, delegation and durable invocation input | `InferIn<I>`; omitted schema remains string |
| Agent prompt, workflow handler and agent loop callbacks | `Infer<I>` |
| Native tool handler and governance prepared input | `Infer<I>` |
| Native tool/workflow handler return | `Promise<InferIn<O>>` or `InferIn<O>` |
| Validated invocation/delegation output | `Infer<O>`; omitted schema remains string |

`defineAgent` has no custom handler. It defines the bounded model loop. Custom
application control flow uses `defineWorkflow`, whose required handler receives
only declared agents, tools, models, memory, sandbox, workspace, identity,
events, and durable helpers.

Validation runs once at each boundary; typing helpers and callers do not
pre-parse values. Model-facing native-tool input and structured agent output use
the Standard JSON Schema input projection because the model supplies pre-parse
values. Unsupported projection fails closed before provider I/O.

### Native tool inference

`defineTool(id, { input, output, handler })` contextually types the handler's
validated input and constrains its raw return to the output schema input. A tool
that declares sandbox requirements contributes those exact requirements to any
agent or workflow that references it. `defineMcpServer` produces frozen typed
remote-tool references; native and MCP tools may coexist in one agent `tools`
array without an intermediate registration object.

Use `TsToolDefinition<typeof input, typeof output>['handler']` or
`WorkflowDefinition<typeof input, typeof output>['handler']` when extraction is
necessary. Guardrail evaluators continue to use their owning definition types.

## Acceptance

Type tests prove inline and extracted callbacks, transformed schemas, omitted
string defaults, incompatible alias rejection, handler output checking, and
sandbox capability inference. Runtime tests prove closed-shape validation,
single parsing at every boundary, direct and catalog composition, mixed native
and MCP tools, and atomic failure before resource initialization.
