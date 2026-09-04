# Composable definitions and catalogs

**Status:** repository-owner-approved clean-break contract, independently verified.

**Decision date:** 2026-09-04.

This specification replaces the public construction, registration, agent,
workflow, tool, Skill, module, and runtime-instantiation API described by specs
00, 02, 07, 08, 09, 10, 13, 25, and 40 where they conflict. It also replaces
the former contents of this file. Existing
storage, memory, sandbox, model-provider, governance, Guardrail, streaming,
approval, telemetry, and persistence semantics remain normative unless this
specification changes their authoring or composition surface explicitly.

There is no compatibility layer. Removed builders, overloads, aliases, types,
exports, examples, and documentation are deleted in the same release.

## 1. Outcome

Harness applications are assembled from small immutable values:

- `defineTool` defines a portable native TypeScript tool;
- a host framework such as PURISTA may define a host-aware tool with the same
  model-facing contract and a richer, framework-owned handler context;
- `defineMcpServer` defines a typed set of explicitly selected MCP tools while
  runtime bindings own URLs, commands, credentials, and process environment;
- `defineSkill` defines one Agent Skill directory and optional runtime requirements;
- `defineAgent` defines one configurable model loop and never accepts an arbitrary execution handler;
- `defineWorkflow` defines explicit application orchestration and owns its custom handler;
- `defineCatalog` optionally packages definitions for reuse; and
- `defineHarness` composes definitions with model requirements and returns an
  immutable definition that can be instantiated directly or mounted by a host.

The shortest useful application remains small:

```ts
const assistant = defineAgent('assistant', {
  instructions: 'Answer the user clearly and concisely.',
})

const assistantHarness = defineHarness({ name: 'assistant' })
  .addAgent(assistant)

const runtime = await assistantHarness.getInstance({
  model: {
    provider: openai({ apiKey: process.env.OPENAI_API_KEY! }),
    model: 'gpt-5-mini',
  },
})

const session = await runtime.getSession('conversation-1')
const outcome = await session.agents.assistant.run('How can I reset my PIN?')
```

Defaults for this form are model alias `primary`, string input and output,
streaming text updates, the standard bounded loop, no optional capabilities,
and content-free production telemetry. Adding schemas, tools, Skills,
subagents, Guardrails, persistence, admission, or custom adapters refines the same
definition without changing its mental model.

## 2. Definition identity and immutability

Every definition has a stable `kind`, `id`, contract, and hidden library-owned
identity. Factories validate ids synchronously and return frozen values.
Definitions contain no live provider client, credentials, mutable registry, or
running resource unless a native tool handler is the declared implementation.
The hidden identity-kind vocabulary is closed to `tool`, `built-in-tool`,
`host-tool`, `mcp-tool`, `skill`, `mcp-server`, `agent`, `workflow`, `catalog`,
and `harness`. The public `kind` remains model-facing where appropriate, so all
non-MCP tools expose `kind: 'tool'` even though compilation can distinguish
their hidden implementation identity.

Tool, MCP server, agent, workflow, and catalog ids plus the required Harness
`name` use lower camel case and match `/^[a-z][A-Za-z0-9]{0,63}$/`. Skill ids retain the external Agent
Skills kebab-case grammar and must match the loaded `SKILL.md` name.

The same definition value may be referenced by several agents or catalogs and
is registered once. Two different definitions with the same `(kind, id)` are a
configuration error. Resolution never uses first-wins or last-wins behavior.

Definitions are ordinary imported values. They do not use `BuilderState`,
callback identity wrappers, `getDefinition()`, `.define()`, `.build()`, or a
global process registry.

Every fluent `add*` and `use` call returns a new frozen Harness definition and
never mutates its receiver. Adding an agent or workflow recursively collects
the branded tool, Skill, MCP server, and agent definitions it references. The
public catalog view is the flattened, deduplicated dependency closure. Authors
may add leaf definitions explicitly for reusable catalogs, but never need to
repeat dependencies reachable from a root. Foreign structural lookalikes and
different hidden identities with the same `(kind, id)` fail graph compilation.

Each agent and workflow exposes a self-contained `HarnessTargetContract` with
literal `kind`, literal `id`, optional description, input/output Standard JSON
Schemas, aggregate/stream support, output-update kind, and interrupt types. The
contract contains no implementation, prompt, provider, or credential data.

The public shape is exact and intentionally small:

```ts
type HarnessTargetKind = 'agent' | 'workflow'
type HarnessExecutionMode = 'run' | 'stream'
type HarnessOutputUpdateKind = 'none' | 'text-delta' | 'object-snapshot'
type HarnessInterruptKind = 'tool-approval' | 'external-wait'

interface HarnessTargetContract<
  Kind extends HarnessTargetKind,
  Id extends string,
  Input extends ModelSchema,
  Output extends ModelSchema,
  Updates extends HarnessOutputUpdateKind,
  Interrupts extends readonly HarnessInterruptKind[],
> {
  readonly kind: Kind
  readonly id: Id
  readonly description?: string
  readonly input: Input
  readonly output: Output
  readonly executionModes: readonly ['run', 'stream']
  readonly updates: Updates
  readonly interrupts: Interrupts
}

type AnyHarnessTargetContract = HarnessTargetContract<
  HarnessTargetKind,
  string,
  ModelSchema,
  ModelSchema,
  HarnessOutputUpdateKind,
  readonly HarnessInterruptKind[]
>

type HarnessTargetInput<Target> =
  Target extends HarnessTargetContract<any, any, infer Input, any, any, any>
    ? InferIn<Input>
    : never

type HarnessValidatedTargetInput<Target> =
  Target extends HarnessTargetContract<any, any, infer Input, any, any, any>
    ? Infer<Input>
    : never

type HarnessTargetOutput<Target> =
  Target extends HarnessTargetContract<any, any, any, infer Output, any, any>
    ? Infer<Output>
    : never

const harnessExecutionEventTypesV1 = Object.freeze([
  'run.started',
  'run.finished',
  'agent.started',
  'agent.finished',
  'model.message',
  'model.completed',
  'model.embedding.completed',
  'model.rerank.completed',
  'output.text.delta',
  'output.object.snapshot',
  'output.file',
  'output.progress',
  'tool.input.available',
  'tool.started',
  'tool.finished',
  'policy.exposure',
  'policy.evaluated',
  'approval.requested',
  'approval.responded',
  'external_wait.requested',
  'external_wait.waiting',
  'external_wait.resolved',
  'fanout.started',
  'fanout.finished',
  'child_task.started',
  'child_task.settled',
  'stream.overflow',
] as const)

type HarnessExecutionEventType = typeof harnessExecutionEventTypesV1[number]

type ExecutionTerminalOutcome<Output, Interrupt> =
  | RunOutcome<Output, Interrupt>
  | Readonly<{ status: 'failed'; runId: string; error: SerializedError }>
  | Readonly<{ status: 'cancelled'; runId: string; error: SerializedError }>

type ExecutionEventCorrelation = Readonly<{
  runId: string
  parentRunId?: string
  parentInvocationId?: string
}>

type ExecutionEvent<
  Output = JsonValue,
  Interrupt = HarnessInterrupt,
> = ExecutionEventCorrelation & (
  | Readonly<{ type: 'run.started'; at: string }>
  | Readonly<{
      type: 'run.finished'
      at: string
      outcome: ExecutionTerminalOutcome<Output, Interrupt>
    }>
  | Readonly<{
      type: 'agent.started'
      agentId: string
      at: string
      workflowId?: string
      parentAgentId?: string
      delegationCallId?: string
      delegationDepth?: number
      modelAlias?: string
    }>
  | Readonly<{
      type: 'agent.finished'
      agentId: string
      at: string
      workflowId?: string
      parentAgentId?: string
      delegationCallId?: string
      delegationDepth?: number
      modelAlias?: string
      output?: JsonValue
      error?: SerializedError
    }>
  | Readonly<{ type: 'model.message'; agentId: string; message: Message }>
  | Readonly<{
      type: 'model.completed'
      agentId?: string
      workflowId?: string
      modelAlias: string
      streamId?: string
      operation: 'text' | 'object' | 'textStream' | 'objectStream'
      usage?: TokenUsage
      finishReason?: FinishReason
    }>
  | Readonly<{
      type: 'model.embedding.completed'
      agentId?: string
      count: number
      dimensions?: number
      usage?: TokenUsage
    }>
  | Readonly<{
      type: 'model.rerank.completed'
      agentId?: string
      count: number
      topN?: number
      usage?: TokenUsage
    }>
  | Readonly<{
      type: 'output.text.delta'
      id: string
      agentId?: string
      workflowId?: string
      modelAlias?: string
      delta: string
    }>
  | Readonly<{
      type: 'output.object.snapshot'
      id: string
      agentId?: string
      workflowId?: string
      modelAlias?: string
      value: JsonValue
    }>
  | Readonly<{
      type: 'output.file'
      id: string
      agentId?: string
      workflowId?: string
      modelAlias: string
      operation: 'image' | 'speech' | 'video'
      artifact: ArtifactReference
    }>
  | Readonly<{
      type: 'output.progress'
      id: string
      agentId?: string
      workflowId?: string
      modelAlias: string
      operation: 'video'
      state: 'queued' | 'running'
      progress?: number
    }>
  | Readonly<{
      type: 'tool.input.available'
      agentId: string
      toolId: string
      callId: string
      input: JsonValue
    }>
  | Readonly<{
      type: 'tool.started'
      agentId: string
      toolId: string
      callId: string
      input: JsonValue
    }>
  | Readonly<{
      type: 'tool.finished'
      agentId: string
      toolId: string
      callId: string
      output?: JsonValue
      error?: SerializedError
    }>
  | Readonly<{
      type: 'policy.exposure'
      agentId: string
      invocationId: string
      toolId: string
      step: number
      evidence: DecisionEvidence
      effect: GovernanceExposureEffect
      enforced: boolean
    }>
  | Readonly<{
      type: 'policy.evaluated'
      agentId: string
      invocationId: string
      toolId: string
      callId: string
      step: number
      evidence: DecisionEvidence
      effect: GovernanceEffect
      enforced: boolean
    }>
  | Readonly<{
      type: 'approval.requested'
      agentId: string
      invocationId: string
      toolId: string
      callId: string
      step: number
      approvalId: string
      demands: readonly DecisionEvidence[]
    }>
  | Readonly<{
      type: 'approval.responded'
      agentId: string
      invocationId: string
      toolId: string
      callId: string
      step: number
      approvalId: string
      approved: boolean
    }>
  | Readonly<{
      type: 'external_wait.requested'
      at: string
      waitId: string
      kind: string
      schemaVersion: string
      definitionVersion: string
      deadline: string
    }>
  | Readonly<{
      type: 'external_wait.waiting'
      at: string
      waitId: string
      kind: string
      deadline: string
    }>
  | Readonly<{
      type: 'external_wait.resolved'
      at: string
      waitId: string
      kind: string
      outcome: ExternalWaitOutcome
      deadline: string
    }>
  | Readonly<{
      type: 'fanout.started'
      batchId: string
      at: string
      count: number
      concurrency: number
    }>
  | Readonly<{
      type: 'fanout.finished'
      batchId: string
      at: string
      count: number
      status: 'succeeded' | 'failed' | 'cancelled'
    }>
  | Readonly<{
      type: 'child_task.started'
      taskId: string
      at: string
      parentRunId: string
      workflowId: string
      agentId: string
      modelAlias?: string
      contextPolicy: ChildTaskContextPolicy
      mode: ChildTaskMode
    }>
  | Readonly<{
      type: 'child_task.settled'
      taskId: string
      at: string
      parentRunId: string
      workflowId: string
      agentId: string
      status: 'succeeded' | 'failed' | 'cancelled'
      error?: SerializedError
    }>
  | Readonly<{ type: 'stream.overflow'; at: string; dropped: number }>
)
```

Every target supports aggregate `run` and progressive `stream`. A text agent
has `updates: 'text-delta'`; an agent with any explicit output schema has
`updates: 'object-snapshot'`. An agent contract declares
`interrupts: ['tool-approval']` because a runtime or host policy may require
approval for selected capabilities. A workflow has `updates: 'none'`: it may
relay child, model, progress, artifact, and terminal events, but its custom
handler cannot manufacture output updates. A workflow declares
`interrupts: ['tool-approval', 'external-wait']`. These arrays describe the
portable protocol families a client must understand; they do not claim that a
particular run will interrupt.

`harnessExecutionEventTypesV1` is the frozen canonical event-type inventory
used by standalone inspection, host export, and protocol adapters. The exact
`ExecutionEvent` union above is authoritative for every portable payload;
specs 12 and 37 remain authoritative only for ordering, privacy, persistence,
and decision semantics. The clean v4 name replacements are: `model.delta` becomes
`output.text.delta`, `model.object.partial` and streamed `model.object` become
`output.object.snapshot`, `model.artifact` becomes `output.file`,
`model.media.progress` becomes `output.progress`, and `approval.finished`
becomes `approval.responded`. There are no aliases for the replaced names.
For `output.text.delta`, `id` is the model stream id. For
`output.object.snapshot`, the former partial or object value is normalized to
`value`; `id` is the stable model stream id, or a Harness-derived stable output
id when the source operation has no stream id. For `output.file`, `id` equals
`artifact.id`. For `output.progress`, `id` is a stable Harness operation id
shared by all updates for that generation. Both partial and final object
snapshots use the same shape; the terminal validated output remains on the
completed `run.finished` outcome. `approval.responded.approved` is true only
for the former `approved` outcome and false only for the former `rejected`
outcome; cancelled, timed-out, or failed approval processing terminates the run
and does not emit a response event.

Every event carries its own `runId`. Relayed nested events additionally carry
the optional immediate `parentRunId` and stable `parentInvocationId`; root
events omit both. The `runId` inside a `run.finished.outcome` must equal the
outer event `runId`. `run.finished` uses the exact terminal union above, so
interruption is data rather than an error, while failed and cancelled streams
finish with one sanitized `SerializedError`.
Aggregate `run` rejects for failed or cancelled execution and returns
`RunOutcome` only for completed or interrupted execution.

The v4 inventory removes `skill.started` and `skill.finished`. Skills are inert
mounted guidance, not executable calls; a script deliberately wrapped as a
typed tool is observed through the ordinary tool events.

## 3. Tools and MCP

### 3.1 Portable native tools

```ts
const calculateRisk = defineTool('calculateRisk', {
  description: 'Calculate a risk score from transaction facts.',
  input: calculateRiskInputSchema,
  output: calculateRiskOutputSchema,
  async handler(context, input) {
    return calculateRiskScore(input, context.signal)
  },
})
```

`defineTool` contextually types `input`, constrains the handler result, and
provides signal, logger, metrics, telemetry, identity,
session/run/agent/tool/call identifiers, and idempotency metadata. Its optional
`requires` field uses the existing `MemoryCapability` and `AdapterCapability`
unions. Only declared memory and sandbox capabilities appear as non-optional
typed handles in the handler context and contribute to runtime requirements.
Without `requires`, no memory or sandbox execution handle is present.

Harness exports immutable built-in tool references through `builtInTools`:
`bash`, `read`, `write`, `edit`, `glob`, `grep`, and `list`. Agents select them
in the ordinary `tools` array. Each contributes its exact sandbox capabilities;
for example `bash` contributes `sandbox.exec`, while write/edit contribute file
mutation capabilities. Agent permissions constrain selected tools but never
select a tool or grant its underlying sandbox capability. A Skill runtime
requirement never adds a built-in tool automatically.

### 3.2 Host-aware tools

Host-aware tools have the same immutable model-facing identity, description,
input schema, and output schema. Their implementation kind and handler context
remain host-owned. `@purista/harness` exposes a narrow host-tool contract for
integrators; ordinary PURISTA users author these through
`ServiceBuilder.defineTool(...)`, which supplies command-style resource,
message, invocation, stream, queue, event, agent, workflow, logger, metrics,
and cancellation helpers.

An agent lists portable and host-aware definitions in the same `tools` array.
The agent cannot observe their implementation kind.

All non-MCP tools implement one identity-bearing model-facing base contract so
agent and catalog typing does not depend on the handler context:

```ts
type NonMcpToolIdentityKind = 'tool' | 'built-in-tool' | 'host-tool'

type NonMcpToolDefinition<
  IdentityKind extends NonMcpToolIdentityKind,
  Id extends string,
  Input extends ModelSchema,
  Output extends Schema,
> = Readonly<{
  kind: 'tool'
  id: Id
  description: string
  input: Input
  output: Output
  $infer: DefinitionInference<Input, Output>
}> & DefinitionReference<IdentityKind, Id>

type AnyNonMcpToolDefinition =
  | ToolDefinition<any, any, any, any>
  | BuiltInToolDefinition<any, any, any>
  | HostToolDefinition<any, any, any, any>

type AnyToolDefinition = AnyNonMcpToolDefinition | McpToolDefinition<any, any, any>
```

Portable, built-in, and host-tool definitions extend that base with their own
implementation fields and exact handler context. The graph compiler recognizes
all three hidden identity kinds, while model-visible tool selection uses the
shared contract. Only package factories can create a valid hidden identity.

### 3.3 MCP servers

`defineMcpServer(id, definition)` declares one server and an explicit typed
tool surface. It does not select a transport and does not contain a production
URL, bearer token, process command, environment values, install instruction, or
mutable client.

```ts
const knowledgeMcp = defineMcpServer('knowledge', {
  tools: {
    searchKnowledge: {
      remoteName: 'search_knowledge',
      description: 'Search approved knowledge.',
      input: searchKnowledgeInputSchema,
      output: searchKnowledgeOutputSchema,
    },
  },
})

const answerQuestion = defineAgent('answerQuestion', {
  instructions: 'Answer with evidence from approved knowledge.',
  tools: [knowledgeMcp.tools.searchKnowledge],
})
```

The local object key is the typed model-facing tool id. `remoteName` is the
exact upstream MCP tool name. Runtime discovery verifies that every declared
tool exists. Declared and discovered input schemas are projected to the
supported JSON Schema subset, remove only annotation keys `title`,
`description`, `$comment`, and `examples`, recursively sort object keys and
`required` arrays, and then require exact equality. Unsupported keywords,
missing schemas, or unequal schemas fail instance creation. MCP results are
validated against the declared output Standard Schema. Static TypeScript types
always come from the declared schemas.

The Harness instance binding is an exact discriminated union:

```ts
type McpBinding =
  | {
      transport: 'http'
      url: string
      headers?: Readonly<Record<string, string>>
    }
  | {
      transport: 'stdio'
      command: string
      args?: readonly string[]
      env?: Readonly<Record<string, string>>
      sandbox: SpawnCapableSandbox
    }
```

It selects `http` or `stdio` and supplies URL,
authenticated headers, and connection options for HTTP, or command, arguments,
minimal environment, and a spawn-capable sandbox for stdio. Agents select exact
MCP tool references.
`SpawnCapableSandbox` is the exported capability-narrowed Sandbox adapter type
whose declared capabilities include `sandbox.spawn`; instance validation checks
that capability again before opening a session.
Dynamic discovery may be exposed only through a deliberately untyped advanced
API and must never auto-expose newly discovered tools. HTTP and stdio calls use
the same tool policy, approval, Guardrail, validation, telemetry, cancellation,
and output pipeline as native tools.

The Harness instance owns the HTTP clients and stdio processes created from
these bindings and closes them once. The stdio sandbox follows its existing
ownership marker.

Each selected MCP tool carries private type metadata for the exact owning
`McpServerDefinition`, including its complete typed tool map, as well as the
exact runtime owner object in hidden identity metadata. This lets recursive
catalog inference recover the original server definition and reject unknown
nested tool keys without exposing a public `serverId` or string lookup.

## 4. Agent Skills and executable scripts

The minimal Skill definition is:

```ts
const transactionAnalysis = defineSkill('transaction-analysis', {
  directory: new URL('./transaction-analysis', import.meta.url),
  runtimes: ['python'],
})
```

`runtimes` is optional and contains logical runtime ids. A runtime requirement
is an availability requirement, not permission and not an installation
instruction. The selected sandbox reports its available runtimes through
Sandbox runtime metadata. A Harness instance fails before use when an assigned
Skill requires a runtime the instance cannot provide.

The initial closed runtime-id union is `'node' | 'python' | 'shell'`. The public
`Sandbox` port has optional data-only
`readonly runtimes?: readonly SkillRuntimeId[]` metadata; omission means that
the adapter declares no Skill runtimes. When the compiled graph requires at
least one Skill runtime, the graph-level sandbox binding type requires the
`runtimes` property and instance validation requires it to contain every
required runtime id. Runtime metadata never grants process execution,
filesystem, environment, or network permission. `defineSkill` validates the id
grammar synchronously; instance compilation loads `SKILL.md` and verifies that
its declared `name` matches the definition id before `getInstance()` resolves.

Skill definitions do not enumerate scripts and do not declare script input or
output schemas, hashes, review state, or per-script policies. `SKILL.md`
documents script paths and CLI use. Scripts are mounted inert and read-only.
Declaring a Skill or runtime does not grant process execution, environment,
filesystem write, or network access. Those capabilities remain explicit agent
permissions enforced by the sandbox and decision pipeline.

When an application needs a stable typed script interface, it wraps the script
in a native or host-aware tool. Tool schemas then validate the supported
boundary; arbitrary CLI use does not pretend to have a structured contract.

The standard loop receives a Harness-owned skill-scoped reader that can read
only the selected mounted Skill directories. Selecting a Skill does not require
or imply the broad built-in filesystem `read` tool.

## 5. Agents are configurable model loops

```ts
const transactionAnalyst = defineAgent('transactionAnalyst', {
  description: 'Analyzes one transaction for unusual activity.',
  model: 'fast',
  input: transactionAnalysisInputSchema,
  output: transactionAnalysisOutputSchema,
  instructions: 'Use the supplied facts and return a concise assessment.',
  prompt: input => [
    { role: 'user', content: [{ kind: 'text', text: JSON.stringify(input) }] },
  ],
  tools: [getTransaction],
  skills: [transactionAnalysis],
  guardrails: transactionGuardrails,
  subagents: { policySpecialist },
  loop: {
    maxSteps: 8,
    maxToolCalls: 12,
    maxSubagentCalls: 3,
    maxParallelSubagents: 1,
    maxDepth: 1,
  },
})
```

The definition-time fields are closed and have these requirement effects:

| Field | Public type and behavior | Requirement contribution |
| --- | --- | --- |
| `description` | optional nonempty string | none |
| `model` | `ModelAliasId`, default `primary` | selected output/tool/input capabilities |
| `input` | Standard JSON Schema; omission means Harness string schema | none |
| `output` | Standard JSON Schema; omission means text | object/object-stream when present |
| `instructions` | string | none |
| `prompt` | pure `(input) => UserModelMessage | readonly UserModelMessage[]` | content kinds validated below |
| `inputCapabilities` | readonly `vision_input | audio_input | file_input` ids | selected model capabilities |
| `tools` | readonly branded tool references | tool and adapter requirements |
| `skills` | readonly Skill references | Skill runtimes and scoped reader |
| `guardrails` | `AgentGuardrailsBinding<Requirements>` | its exact declared requirements |
| `permissions` | existing `AgentPermissions` | restriction only; `require_approval` adds durable storage |
| `subagents` | typed agent map | graph closure and delegation tools |
| `loop` | closed positive integer limits | none |
| `memory` | `AgentMemoryPolicy` | memory capabilities and declared model aliases |
| `sandbox` | existing `SandboxPolicy` | partition and sharing policy only |
| `workspace` | optional literal `true` | workspace binding |
| `durable` | optional literal `true` | durable Harness storage |

`model` is a lower-camel string literal `ModelAliasId` that identifies a
runtime requirement. `ModelAlias` remains the concrete provider/model runtime
binding and is never accepted by `defineAgent`.

The Core-owned Guardrail requirement declaration is exact and does not grant a
capability or inject a runtime handle:

```ts
interface AgentExecutionRequirements {
  readonly tools?: readonly string[]
  readonly models?: readonly Readonly<{
    alias: ModelAliasId
    capabilities: readonly ModelCapability[]
  }>[]
  readonly memory?: readonly MemoryCapability[]
  readonly sandbox?: readonly SandboxCapabilityId[]
  readonly skillRuntimes?: readonly SkillRuntimeId[]
  readonly durable?: true
  readonly workspace?: true
  readonly artifacts?: true
}

interface AgentExecutionInterceptor<
  Requirements extends AgentExecutionRequirements | undefined =
    AgentExecutionRequirements | undefined,
> {
  readonly id: string
  readonly requirements?: Requirements
  // Existing interception callbacks remain unchanged.
}

interface AgentGuardrailsBinding<
  Requirements extends AgentExecutionRequirements | undefined =
    AgentExecutionRequirements | undefined,
> {
  readonly [agentGuardrailsBinding]: AgentExecutionInterceptor<Requirements>
}
```

Every optional array is nonempty and duplicate-free when present. All ids and
capability members are validated during definition/graph compilation; model
aliases use the lower-camel grammar. Guardrail `tools` must already be selected by the agent. The
concrete binding and `defineAgent` preserve the requirements type so static and
runtime `RuntimeRequirements` contain the same contributions. Optional
Guardrails packages must return this exact generic binding rather than erase it.

The memory policy is exact:

```ts
type AgentMemoryPolicy<C extends readonly MemoryCapability[]> = Readonly<{
  capabilities: C
  embedding?: Readonly<{ model: ModelAliasId }>
  summary?: Readonly<{
    model: ModelAliasId
    everyTurns?: number
    sourceTurns?: number
  }>
}>
```

Positive `everyTurns` and `sourceTurns` values, embedding selection, summary
cadence, source-window behavior, validation, and orchestration retain the
existing `MemoryConfiguration` semantics. The runtime `memory` binding is only
a capability-compatible `MemoryEngine`; it contains no agent behavior
configuration. Local in-memory memory satisfies only non-durable baseline
capabilities. Approval-capable tools/Guardrails and delegated interruption
require durable storage so resume can survive process boundaries. There is no
evaluation definition or inferred evaluation runtime requirement in this
composition contract.

An agent owns configuration only: model alias, input/output contract,
instructions, tools, Skills, Guardrails, permissions, subagents, sandbox
policy, and bounded declarative loop settings. An agent has no general
`handler`. Custom control flow is a workflow. Per-step agent hooks are not part
of this release; adding them later requires a separate pure, typed contract.

Tool, Skill, and subagent properties accept typed definition references, not
manually synchronized string ids. The Harness compiler converts them into
provider-facing names and schemas.

If `input` is omitted, it is a string. If `output` is omitted, the agent is a
text agent and its final output is a string. Supplying `output` makes the agent
a structured agent. If `model` is omitted, the alias is `primary`. `run`
aggregates; `stream` performs real provider streaming. Text agents produce text
deltas and structured agents produce object snapshots. Agent authors do not
configure a separate `updates` mode.

A non-string input must declare a pure prompt mapper:

```ts
const classify = defineAgent('classify', {
  input: classifyInputSchema,
  output: classifyOutputSchema,
  instructions: 'Classify the support request.',
  prompt: input => [
    { role: 'user', content: [{ kind: 'text', text: input.message }] },
  ],
})
```

The mapper receives validated input and returns one provider-neutral user
message or a readonly list of user messages. Every returned message has the
literal role `user`; input cannot create system, assistant, or tool history. It
cannot access tools, models, agents, storage, resources, or the network.
Session history is composed after prompt mapping. Omitting `prompt` is
valid only when `input` is omitted. Supplying any `output` schema, including a
string schema, selects structured model mode; omit `output` for a text agent.
For a structured input, `inputCapabilities` statically allow non-text prompt
parts and contribute to the model requirement. Runtime rejects image, audio, or
file content returned without its declared capability before provider I/O.

For each agent, effective model-facing names must be unique across portable
tools, MCP local tool ids, built-in tools, and subagent object keys. A collision
fails graph compilation and reports both origins. An MCP tool's internal
identity remains `(serverId, localToolId)`.

## 6. Subagents

A subagent is a model-selectable invocation capability, not nested ownership
and not a JavaScript function call.

```ts
const answerQuestion = defineAgent('answerQuestion', {
  instructions: 'Answer the question. Delegate transaction analysis when needed.',
  input: questionSchema,
  output: answerSchema,
  prompt: input => [
    { role: 'user', content: [{ kind: 'text', text: input.question }] },
  ],
  tools: [searchKnowledge],
  subagents: { transactionAnalyst },
})
```

The object key is the provider-facing delegation name. The referenced agent
provides its description, input schema, output schema, and stable identity. A
long form may override only the parent-facing description:

```ts
subagents: {
  analyst: {
    agent: transactionAnalyst,
    description: 'Use for questions that require transaction risk analysis.',
  },
}
```

The Harness exposes each selected subagent as a generated typed delegation
tool. Input is validated before dispatch. The child runs with its own model,
tools, Skills, Guardrails, permissions, sandbox policy, history, and budgets. A
parent cannot widen or replace them. The validated child output becomes the
delegation tool result.

Every subagent call goes through a `HarnessTargetDispatcher` port. The standalone
default resolves registered definitions locally. A PURISTA mount resolves the
same logical target to a service/version/target address and always invokes it
through EventBridge. Agent and provider admission apply at the target before
model execution. Trusted identity, trace, session/run
ancestry, cancellation, deadlines, and idempotency propagate.

```ts
type HarnessTargetDispatchRequest<
  Target extends AnyHarnessTargetContract,
> = Readonly<{
  target: Target
  input: HarnessTargetInput<Target>
  invocation: Readonly<{
    sessionId: string
    invocationId: string
    rootRunId: string
    parentRunId: string
    parentAgentId?: string
    parentWorkflowId?: string
    depth: number
    remainingDepth: number
    identity?: TrustedIdentity
    deadline?: number
    idempotencyKey?: string
    signal: AbortSignal
  }>
}>

interface HarnessTargetDispatchStream<O> extends AsyncIterable<ExecutionEvent<O>> {
  cancel(reason?: string): Promise<void>
}

interface HarnessTargetDispatcher {
  open<Target extends AnyHarnessTargetContract>(
    request: HarnessTargetDispatchRequest<Target>,
  ): Promise<HarnessTargetDispatchStream<HarnessTargetOutput<Target>>>
}
```

Public invokers and `HarnessTargetDispatcher` accept
`HarnessTargetInput<Target>`, the schema's input type. The dispatcher is a
transport boundary and does not validate or transform the value. Its receiving
target validates exactly once into `HarnessValidatedTargetInput<Target>` before
execution. The standalone local dispatcher is itself that receiving boundary.
A PURISTA EventBridge receiver validates the raw transported value before it
enters the hosted Harness. Output is validated by the executing target before
it crosses the dispatcher boundary.

Every dispatcher owns an immutable binding table keyed by the target contract's
hidden library identity. The standalone compiler binds contracts from its
completed graph to local definitions. A host binds completed graph contracts
and explicitly declared remote contracts to host-private routes. `open` rejects
an unknown or structurally copied contract before dispatch and never resolves
solely by `(kind, id)`. Route values are opaque to Harness; PURISTA stores the
service/version/target address in its dispatcher table.

`open` is the single nested-target primitive. The caller consumes the stream to
its undroppable terminal outcome and relays child events with their child run
id and parent invocation id. A child gets isolated conversation history and a
fresh child session derived from the parent session; ancestry remains metadata.
Only remaining delegation depth crosses the dispatch boundary. Every agent has
`loop.maxDepth`; every workflow has `maxDepth`, using the same default when it
is omitted. A root agent or workflow starts at depth zero with its configured
maximum as `remainingDepth`. Every nested agent or workflow edge consumes one:
dispatch requires positive remaining depth, child depth is parent depth plus
one. The caller transmits `parentRemainingDepth - 1` as the child ceiling; it
does not need the remote target configuration. Before execution, the receiver
sets effective remaining depth to
`min(transmittedRemainingDepth, targetConfiguredMaxDepth)`. Replaying a saved
logical child call consumes no additional depth. `maxSteps`, `maxToolCalls`, and
`maxSubagentCalls` are local to each agent invocation;
`maxParallelSubagents` is local to the invoking parent. A future root-global
call limit requires a separate atomic distributed budget port.
The standalone dispatcher opens a registered local target. A host
dispatcher has no implicit local fallback.

Child lifecycle and allowed output updates remain observable with parent/child
correlation. The parent model consumes the final validated child result rather
than an unbounded child stream. The compiled agent graph must be acyclic.
Self-delegation and direct or transitive cycles fail during validation.
Repeated or reciprocal cooperation belongs in a workflow.

If a child interrupts, the root run also returns `interrupted` with an opaque,
correlated child continuation. Resume routes to the exact child target, run,
interrupt id, revision, and event id. Once the child completes, its validated
output becomes the delegation-tool result and the suspended parent loop
continues. A child interrupt never becomes a tool error.

Model-selected delegation uses the provider tool-call id as its stable call id.
`invocationId` is an opaque hash of parent run id, caller kind/id, call id, and
target id. The isolated child session id is an opaque hash of parent session id,
root run id, invocation id, and target id. Repeating the same invocation
identity replays its checkpoint; reuse with different validated input fails.

## 7. Workflows own custom orchestration

```ts
const resolveSupportCase = defineWorkflow('resolveSupportCase', {
  input: supportCaseSchema,
  output: supportResolutionSchema,
  agents: {
    classify: classifySupportCase,
    answer: answerQuestion,
  },
  models: {
    embeddings: {
      alias: 'embeddings',
      capabilities: ['embeddings'],
    },
  },
  async handler(context) {
    const classification = await context.agents.classify.run(
      context.input,
      { callId: 'classifyCase' },
    )
    return context.agents.answer.run({
      question: context.input.message,
      classification,
    }, { callId: 'answerCase' })
  },
})
```

The `agents` and `models` declarations form the exact typed context allowlist.
Workflows may implement sequencing, branching, parallelism, retries, durable
steps, waits, approvals, embeddings, reranking, media generation, and explicit
agent calls. They retain the existing bounded fan-out and child-task APIs.
Workflow agent calls use the same `HarnessTargetDispatcher` as model-selected
subagents. A workflow cannot access an undeclared agent or model through a
registry lookup.

Inside a workflow, every agent call requires a stable `callId` identifying one
logical child call and matching the durable step-id grammar. Re-entering the
handler with the same `callId`, target, and canonically equivalent validated
input replays the saved result. Reuse with another target or input fails
closed. Parallel logical child calls use distinct ids. Workflow child-call ids
and `context.step` ids occupy separate internal namespaces. Declared invokers
return the typed child output:
`context.agents.classify.run(input, { callId }): Promise<ClassifyOutput>`.
Public Harness
and host invokers still return `RunOutcome<Output>`. The workflow runtime
implements the internal convenience by consuming `HarnessTargetDispatcher.open()` and
checkpointing completed steps. A child interrupt suspends the root outcome;
resume continues from the child checkpoint and does not repeat completed child
calls. Arbitrary workflow side effects are replay-safe only when wrapped in
`context.step`; Harness cannot prevent repetition of unmanaged effects when a
handler is re-entered. Existing child-task fan-out is restricted to the
workflow's declared agent map and uses the same dispatcher.

`defineWorkflow` has required Standard JSON Schema `input` and `output` plus a
required `handler`; optional
`description`, exact typed `agents`, exact typed `models`, existing sandbox
policy, positive integer `maxDepth`, literal `workspace: true`, and literal
`durable: true`. Its model
entries declare an alias and nonempty capability list. Workspace and durable
fields contribute the same requirements as agent fields. Harness options contain only `name` and
content-free execution defaults; they never contain live adapters.

## 8. Catalogs and registries

`defineCatalog` is an optional provider-neutral packaging mechanism:

```ts
const bankingAi = defineCatalog('bankingAi', {
  tools: [getTransaction],
  skills: [transactionAnalysis],
  mcpServers: [knowledgeMcp],
  agents: [transactionAnalyst, answerQuestion],
  workflows: [resolveSupportCase],
})
```

It returns one frozen typed value with read-only `tools`, `skills`,
`mcpServers`, `agents`, `workflows`, `contracts`, and `requirements` views. The
factory accepts concise arrays, then derives exact readonly maps keyed by each
definition's literal id. For example, `bankingAi.agents.answerQuestion` is the
original strongly typed definition, and an unknown key is a TypeScript error.
An empty catalog is valid. The maps contain the original frozen definition
values, including a native or host tool handler and an agent prompt mapper when
the application already holds the catalog. They are reusable authoring values,
not sanitized metadata. Only `inspect()`, service-definition export, and
documentation projections remove executable functions and prompt material.

`catalog.tools` contains non-MCP tool definitions only. MCP tools remain nested
under their owning entry in `catalog.mcpServers`, because different servers may
legitimately expose the same local tool id. Adding an MCP tool reference collects
the exact owning MCP server by hidden identity. Explicitly adding an MCP server
makes its declared tools available to the graph but grants none of them to an
agent. Agent and workflow access remains exactly the identity-bearing references
on that definition.

The public catalog and inference shapes are:

```ts
type HarnessContracts<
  Agents extends Readonly<Record<string, AnyAgentDefinition>>,
  Workflows extends Readonly<Record<string, AnyWorkflowDefinition>>,
> = Readonly<{
  agents: Readonly<{ [K in keyof Agents]: Agents[K]['contract'] }>
  workflows: Readonly<{ [K in keyof Workflows]: Workflows[K]['contract'] }>
}>

type HarnessTargetInferMap<
  Targets extends Readonly<Record<string, AnyHarnessTargetContract>>,
> = Readonly<{
  [K in keyof Targets]: Readonly<{
    input: HarnessTargetInput<Targets[K]>
    output: HarnessTargetOutput<Targets[K]>
  }>
}>

type HarnessInfer<
  Contracts extends HarnessContracts<any, any>,
  Requirements extends RuntimeRequirements,
> = Readonly<{
  agents: HarnessTargetInferMap<Contracts['agents']>
  workflows: HarnessTargetInferMap<Contracts['workflows']>
  requirements: Requirements
}>

interface HarnessCatalogView<
  Tools extends Readonly<Record<string, AnyNonMcpToolDefinition>>,
  Skills extends Readonly<Record<string, SkillDefinition>>,
  McpServers extends Readonly<Record<string, McpServerDefinition<any, any>>>,
  Agents extends Readonly<Record<string, AnyAgentDefinition>>,
  Workflows extends Readonly<Record<string, AnyWorkflowDefinition>>,
  Requirements extends RuntimeRequirements,
> {
  readonly tools: Tools
  readonly skills: Skills
  readonly mcpServers: McpServers
  readonly agents: Agents
  readonly workflows: Workflows
  readonly contracts: HarnessContracts<Agents, Workflows>
  readonly requirements: Requirements
}

type HarnessCatalogDefinition<
  Id extends string,
  View extends HarnessCatalogView<any, any, any, any, any, any>,
> = Readonly<{ readonly kind: 'catalog'; readonly id: Id }> & View
```

`AnyNonMcpToolDefinition` is the closed union of portable, built-in, and
integrator-owned host tool definitions available in that build. It never includes
`McpToolDefinition`. `$infer` is a compile-time phantom; its runtime value is a
single frozen empty object and is not an alternate metadata tree.
This catalog is the public definition registry; separate tool, Skill, and agent
registry factories would duplicate the same composition and are not added.
Catalogs contain no providers, credentials, running clients, mutable adapters,
or lifecycle ownership.

`defineHarness(...).use(catalog)` composes catalogs. Direct `.addTool`,
`.addSkill`, `.addMcpServer`, `.addAgent`, and `.addWorkflow` methods support
small applications. Both paths feed one compiler and have identical identity,
typing, validation, and duplicate behavior.

The former `defineHarnessModule`, `HarnessModuleBuilder`, module callback,
`Required`/`Result` builder-state generics, and module provenance format are
removed. Catalog composition is order-independent except for duplicate errors;
references resolve against the completed immutable graph.

Internally, each Harness instance compiles private per-kind registries for
resolved tools, Skills, MCP clients, agents, workflows, models, and runtime
bindings. No registry is global or mutable after instance creation. Runtime
contexts never receive a general registry or string-based lookup escape hatch.

Graph compilation is identity-first and has two phases: collect the complete
dependency closure, then validate collisions, references, agent delegation
cycles, and model-facing names. Reusing one identity deduplicates it. A distinct
identity with the same `(kind, id)` fails with `HarnessConfigError`. The stable
`meta.reason` values are `foreign_definition`, `duplicate_definition`,
`agent_cycle`, and `model_name_collision`. Only agent-to-subagent edges
participate in cycle detection; an MCP tool's private exact-owner edge never does.

The compiler remains package-private. It may accept a package-private dependency
reader solely so tests can forge cyclic branded fixtures that eager immutable
public factories cannot construct. Production composition always uses the
default identity-aware reader. This test seam is not exported and does not add a
lazy or string reference API.

The catalog supports composition, inspection, documentation, export, and
deployment validation. It is not an execution service locator. Runtime code
receives only the definitions or callable capabilities declared on its agent,
workflow, or host-tool builder. Dynamic administrative lookup, when needed,
uses sanitized `inspect()` metadata and never exposes handlers or grants an
invocation capability.

Providing a definition never grants access: agents list their tools, Skills,
and subagents, and workflows list their agents and models. A host decides how a
Harness target is routed or projected to a transport.

An agent or workflow reference always brings the referenced implementation into
the same completed Harness graph. In PURISTA every graph member is mounted by
the same owning service version. A remote cross-service agent is not a
model-selectable subagent in this release; application code calls remote agents
through address-first host declarations.

## 9. Harness definition and runtime

`defineHarness` requires `{ name }` and returns an immutable typed Harness
definition directly. The name uses the id grammar in section 2. It has
`catalog`, `contracts`, `$infer`, `inspect()`, `getInstance(...)`, direct add
methods, and `.use(catalog)`. There is no terminal `.define()` or `.build()`.

Required model aliases and capabilities are compiled from agent behavior,
tools, Guardrails, workflow model declarations, and memory. Tool use adds
`tool_use`; a text agent adds `text` and
`text_stream`; a structured agent adds `object` and `object_stream`. Authors do
not repeat those capabilities on the Harness.

The normalized, readonly `RuntimeRequirements` view contains exact model
aliases and capabilities, MCP server ids, Skill runtime ids, storage
durability, memory capabilities and model aliases, sandbox capabilities,
workspace need, artifact need, and host tool ids. Contributions are
deterministic. Its public shape is:

```ts
type SandboxCapabilityId = Extract<AdapterCapability, `sandbox.${string}`>

interface RuntimeRequirements<
  Models extends Readonly<
    Record<string, Readonly<{ capabilities: readonly ModelCapability[] }>>
  > = Readonly<Record<string, Readonly<{
    capabilities: readonly ModelCapability[]
  }>>>,
  McpServerId extends string = string,
  RuntimeId extends SkillRuntimeId = SkillRuntimeId,
  RequiredMemoryCapability extends MemoryCapability = MemoryCapability,
  MemoryModelAlias extends string = string,
  RequiredSandboxCapability extends SandboxCapabilityId = SandboxCapabilityId,
  HostToolId extends string = string,
  Durable extends boolean = boolean,
  Workspace extends boolean = boolean,
  Artifacts extends boolean = boolean,
> {
  readonly models: Models
  readonly mcpServers: readonly McpServerId[]
  readonly skillRuntimes: readonly RuntimeId[]
  readonly storage: Readonly<{ durable: Durable }>
  readonly memory: Readonly<{
    capabilities: readonly RequiredMemoryCapability[]
    modelAliases: readonly MemoryModelAlias[]
  }>
  readonly sandbox: Readonly<{
    capabilities: readonly RequiredSandboxCapability[]
  }>
  readonly workspace: Workspace
  readonly artifacts: Artifacts
  readonly hostTools: readonly HostToolId[]
}
```

All requirement arrays are deduplicated, lexicographically sorted, and frozen.
Model maps and nested values are frozen and have deterministic key order.
`hostTools` lets the ordinary standalone instance type reject a host-aware graph;
only the integrator entry point can satisfy those bindings.
The literal presence of agent/workflow `durable` and `workspace`, approval
permissions, Guardrail requirement flags, and media-generation model
capabilities is preserved through the definition types. The derived requirement
type therefore exposes literal `true` or `false` for `storage.durable`,
`workspace`, and `artifacts`; it never widens these fields to `boolean` for a
concrete graph.

Requirement derivation follows this order:

- agent output mode and selected tools contribute model capabilities;
- agent `memory` contributes memory capabilities and embedding/summary aliases;
- built-in tools, portable-tool `requires`, Guardrails, and executable runtime
  needs contribute sandbox capabilities; Skills contribute logical runtimes;
- agent/workflow `durable: true`, approvals, and durable child tasks require
  durable storage;
- definition `workspace: true` requires a workspace binding;
- workflow `models` declares embeddings, reranking, image, speech, and video;
- image, speech, and video generation requires an artifact store; and
- `AgentAdmission` and provider `ModelAdmission` are optional deployment
  controls and are never inferred as required.

Default-loop agents produce text or structured output. Embeddings, reranking,
image, speech, and video generation belong in workflows through their declared
typed model handles. Media results are artifact references and emit artifact
and progress events. Multimodal input uses the pure prompt mapper and explicit
provider-neutral content parts.

`HarnessInstanceConfig` is derived only from the canonical
`RuntimeRequirements` value. It does not derive requirements again from
definitions, catalogs, or runtime values. The public conditional shape is:

```ts
type HasMembers<Values extends readonly unknown[]> =
  [Values[number]] extends [never] ? false : true

type Or<Left extends boolean, Right extends boolean> =
  true extends Left | Right ? true : false

type RequiredField<
  Needed extends boolean,
  Key extends PropertyKey,
  Value,
> = Needed extends true
  ? Readonly<{ [Field in Key]: Value }>
  : Readonly<{ [Field in Key]?: never }>

type ModelAliases<Requirements extends RuntimeRequirements> =
  keyof Requirements['models'] & string

type ModelRuntimeBinding = Readonly<Omit<ModelAlias, 'capabilities'>>

type ModelFields<Requirements extends RuntimeRequirements> =
  [ModelAliases<Requirements>] extends [never]
    ? Readonly<{ model?: never; models?: never }>
    : [ModelAliases<Requirements>] extends ['primary']
      ? ['primary'] extends [ModelAliases<Requirements>]
        ? Readonly<{ model: ModelRuntimeBinding; models?: never }>
        : never
      : Readonly<{
          model?: never
          models: Readonly<{
            [Alias in ModelAliases<Requirements>]: ModelRuntimeBinding
          }>
        }>

type SandboxBinding<Requirements extends RuntimeRequirements> =
  Sandbox
  & (HasMembers<Requirements['sandbox']['capabilities']> extends true
    ? Readonly<{ capabilities: readonly AdapterCapability[] }>
    : object)
  & (HasMembers<Requirements['skillRuntimes']> extends true
    ? Readonly<{ runtimes: readonly SkillRuntimeId[] }>
    : object)

type HarnessInstanceConfig<Requirements extends RuntimeRequirements> =
  [Requirements['hostTools'][number]] extends [never]
    ? Readonly<
        ModelFields<Requirements>
        & RequiredField<
          HasMembers<Requirements['mcpServers']>,
          'mcp',
          Readonly<{
            [ServerId in Requirements['mcpServers'][number]]: McpBinding
          }>
        >
        & RequiredField<
          Requirements['storage']['durable'],
          'storage',
          HarnessStorage
        >
        & RequiredField<
          Or<
            HasMembers<Requirements['memory']['capabilities']>,
            HasMembers<Requirements['memory']['modelAliases']>
          >,
          'memory',
          MemoryEngine
        >
        & RequiredField<
          Or<
            HasMembers<Requirements['sandbox']['capabilities']>,
            HasMembers<Requirements['skillRuntimes']>
          >,
          'sandbox',
          SandboxBinding<Requirements>
        >
        & RequiredField<Requirements['workspace'], 'workspace', DurableWorkspace>
        & RequiredField<Requirements['artifacts'], 'artifacts', ArtifactStore>
        & Readonly<{
          agentAdmission?: AgentAdmission
          admission?: ModelAdmission
          logger?: Logger
          telemetry?: TelemetryOptions
        }>
      >
    : never
```

The model cases are exact:

- an empty model-alias set forbids both `model` and `models`;
- the exact alias set `{ primary }` requires `model` and forbids `models`; and
- every other nonempty alias set requires an exact `models` record and forbids
  `model`.

The caller never supplies `capabilities` on a model binding. The compiler
injects the exact, frozen capability tuple from
`RuntimeRequirements.models[alias]` into the normalized alias after validation.
This keeps capability declarations derived from graph behavior and prevents a
runtime caller from weakening or widening them.

Each conditional infrastructure group is required when its canonical
requirement is present and forbidden with `?: never` when it is absent:

- `mcp` is required exactly when `mcpServers` is nonempty;
- `storage` is required exactly when `storage.durable` is literal `true`;
- `memory` is required when memory capabilities or memory model aliases are
  nonempty;
- `sandbox` is required when sandbox capabilities or Skill runtimes are
  nonempty;
- `workspace` is required exactly when `workspace` is literal `true`; and
- `artifacts` is required exactly when `artifacts` is literal `true`.

`agentAdmission`, provider `admission`, `logger`, and `telemetry` remain
optional deployment controls for every standalone graph. A nonempty
`hostTools` requirement makes the standalone config type `never`. The runtime
also rejects a forced or erased-type call for such a graph with
`standalone_host_tools_unsupported`; only the integrator entry point can supply
host bindings.

Runtime bindings contain concrete providers and deployment infrastructure. A
graph with multiple aliases therefore uses this shape:

```ts
const runtime = await bankingHarness.getInstance({
  models: {
    primary: { provider: openaiProvider, model: 'gpt-5.5' },
    fast: { provider: openaiProvider, model: 'gpt-5-mini' },
    embeddings: { provider: openaiProvider, model: 'text-embedding-3-large' },
  },
  mcp: {
    knowledge: {
      transport: 'http',
      url: process.env.KNOWLEDGE_MCP_URL!,
      headers: authHeaders,
    },
  },
  storage,
  memory,
  sandbox,
  workspace,
  agentAdmission,
  admission,
  artifacts,
  logger,
  telemetry,
})
```

`McpBinding` is the exact `http | stdio` union in section 3; it has no additional
timeout, redirect, authentication, working-directory, install, or preparation
fields. MCP keys must exactly equal the required server ids. HTTP URLs must be
absolute `http:` or `https:` URLs and every header value must be a string. A
stdio command must be nonempty, and every argument and environment value must
be a string. Its nested sandbox must declare `sandbox.spawn`. This transport
sandbox is validated independently and never satisfies a graph-level sandbox
requirement.

Instance validation reuses the existing adapter validators and then checks the
compiled requirement supersets. Durable storage passes
`validateHarnessStorage` and declares `storage.persistent`. Memory passes
`validateMemoryEngine` and declares every required memory capability. The
graph-level sandbox declares every required sandbox capability and every
required Skill runtime in its Sandbox runtime metadata. Workspace passes
`validateDurableWorkspace`. Required model aliases, MCP server ids,
capabilities, and runtimes are checked in deterministic lexical order.

For each model binding, `provider.id`, `provider.genAiSystem`, and `model` must
be nonempty strings. Required provider methods are:

| Required model capability | Required provider method |
| --- | --- |
| `text` | `text` |
| `text_stream` | `textStream` |
| `object` | `object` |
| `object_stream` | `objectStream` |
| `embeddings` | `embed` |
| `rerank` | `rerank` |
| `image_generation` | `image` |
| `speech_generation` | `speech` |
| `video_generation` | both `video` and `videoStream` |

`tool_use`, `vision_input`, `audio_input`, and `file_input` are metadata-only
marker capabilities and do not require a unique provider method. When
`provider.info.models` is absent, method validation is authoritative and these
marker capabilities cannot be prevalidated. When it is present, the selected
model must exist and its declared capability list must contain every required
capability, including marker capabilities. Provider metadata never excuses a
missing required method.

Validation is atomic, pure, synchronous, and performs no I/O. It follows this
stable order and stops at the first failure:

1. reject a graph with host-tool requirements;
2. require a non-array object config;
3. reject the lexicographically first unknown top-level key;
4. validate the empty, exact-primary, or multi-model selector form;
5. validate exact aliases and model binding structure;
6. validate provider methods and optional provider model metadata;
7. validate required or forbidden groups in `mcp`, `storage`, `memory`,
   `sandbox`, `workspace`, `artifacts` order;
8. validate each present group in that same order;
9. validate present admissions, logger, and telemetry structurally; and
10. create and freeze the validated snapshot.

All binding failures are `HarnessConfigError` values with a stable
`meta.reason` and the most specific deterministic `meta.path` available:

| `meta.reason` | Meaning |
| --- | --- |
| `standalone_host_tools_unsupported` | ordinary instance creation was attempted for a host-aware graph |
| `invalid_instance_config` | the top-level value or selector form is invalid |
| `missing_runtime_binding` | an inferred alias or infrastructure group is absent |
| `unexpected_runtime_binding` | an unknown alias/key or a forbidden group is present |
| `invalid_runtime_binding` | a supplied binding has an invalid field or adapter shape |
| `model_capability_mismatch` | provider methods or optional model metadata cannot satisfy a required model capability |
| `missing_required_capability` | storage, memory, sandbox, workspace, or Skill-runtime metadata lacks a compiled requirement |

The reason assignment is exact. A non-object config or simultaneous `model`
and `models` selector uses `invalid_instance_config`. An absent required
selector, alias, or infrastructure group uses `missing_runtime_binding`. An
unknown top-level or nested key, unknown alias, forbidden selector, or forbidden
group uses `unexpected_runtime_binding`. A malformed supplied field or adapter
surface uses `invalid_runtime_binding`. Provider method and model-descriptor
failures use `model_capability_mismatch`; a valid adapter that lacks a compiled
non-model capability or runtime uses `missing_required_capability`. Paths use
dot-separated public config keys such as `models.fast.provider.textStream`,
`mcp.knowledge.url`, `sandbox.capabilities`, or `sandbox.runtimes`. When several
keys, aliases, capabilities, or runtimes could fail at the same validation
step, the lexicographically first path wins.

The package-private
`validateHarnessInstanceConfig(requirements, value)` introduced for this
contract consumes the canonical `RuntimeRequirements` snapshot and returns a
frozen `ValidatedHarnessInstanceBindings`. It normalizes all supplied model
bindings into an exact alias-keyed record with the derived capabilities
injected, and copies and freezes configuration wrappers, arrays, MCP data,
maps, and plain option records. Caller-owned providers and adapters retain
their object identity and are never frozen or mutated. The snapshot contains
only validated supplied bindings: it contains no definitions, alternate
requirement derivation, execution registry, client, process, lifecycle callback,
or synthesized storage/memory default.

H4-003 owns only these public config types and this package-private, pure
validation snapshot. It does not implement executable instance assembly.
`getInstance` below remains the final public API and is assembled in H4-008,
which consumes the validated snapshot, creates clients/processes and execution
registries, initializes per-instance in-memory storage or memory only when the
corresponding public group is forbidden because the graph does not require it,
and implements startup rollback plus idempotent shutdown. Executable assembly
never closes borrowed admissions, logger, telemetry, or host dependencies. It
closes clients, processes, and internal adapters the Harness creates; supplied
providers and adapters follow their existing explicit ownership contracts.

The provider-neutral host SPI is public and stable. Its generic spelling may
use internal helper types, but it exposes this information without requiring a
host to inspect compiler state:

```ts
interface HarnessDefinition<
  Catalog extends HarnessCatalogView<any, any, any, any, any, any>,
> {
  readonly kind: 'harness'
  readonly name: string
  readonly catalog: Catalog
  readonly contracts: Catalog['contracts']
  readonly requirements: Catalog['requirements']
  readonly $infer: HarnessInfer<
    Catalog['contracts'],
    Catalog['requirements']
  >
  inspect(): HarnessInspection<Catalog['requirements']>
  getInstance(
    config: HarnessInstanceConfig<Catalog['requirements']>,
  ): Promise<HarnessInstance<Catalog['contracts']>>
}
```

The sanitized inspection shape is exact:

```ts
interface HarnessTargetInspection {
  readonly kind: HarnessTargetKind
  readonly id: string
  readonly executionModes: readonly ['run', 'stream']
  readonly updates: HarnessOutputUpdateKind
  readonly interrupts: readonly HarnessInterruptKind[]
}

interface HarnessInspection<
  Requirements extends RuntimeRequirements = RuntimeRequirements,
> {
  readonly kind: 'harness'
  readonly name: string
  readonly definitions: Readonly<{
    tools: readonly string[]
    skills: readonly string[]
    mcpServers: readonly string[]
    agents: readonly string[]
    workflows: readonly string[]
  }>
  readonly targets: Readonly<{
    agents: readonly HarnessTargetInspection[]
    workflows: readonly HarnessTargetInspection[]
  }>
  readonly requirements: Requirements
}
```

Every inspection array is lexicographically sorted and frozen. Inspection omits
handlers, prompt mappers, instructions, Skill directories and content, schemas
that contain validator functions, providers, transports, credentials, and live
runtime state.

Contracts expose each target kind, id, description, input/output schemas, and
portable update mode. `@purista/harness/integrator` separately exports
`instantiateHostedHarness(definition, config, hostBindings)` with this
normative host boundary:

```ts
declare const hostOwnerBrand: unique symbol
type HostOwnerToken = Readonly<{ [hostOwnerBrand]: true }>

interface HarnessNestedTargetInvoker {
  run<Target extends AnyHarnessTargetContract>(
    target: Target,
    input: HarnessTargetInput<Target>,
    options: Readonly<{ callId: string }>,
  ): Promise<HarnessTargetOutput<Target>>
}

interface HarnessCheckpointStep {
  <T extends JsonValue>(
    stepId: string,
    handler: () => Promise<T>,
    options?: DurableStepOptions,
  ): Promise<T>
}

type HarnessHostContextRequest<HostInvocation> = Readonly<{
  hostInvocation: HostInvocation
  target: Readonly<{ kind: 'agent' | 'workflow'; id: string }>
  tool: Readonly<{ id: string; callId: string }>
  sessionId: string
  runId: string
  rootRunId: string
  invocationId: string
  parentRunId?: string
  depth: number
  remainingDepth: number
  deadline?: number
  signal: AbortSignal
  nestedTargets: HarnessNestedTargetInvoker
  checkpointStep: HarnessCheckpointStep
}>

interface HarnessHostBindings<HostInvocation, HostContext> {
  readonly hostOwner: HostOwnerToken
  readonly targetDispatcher: HarnessTargetDispatcher
  readonly createHostContext:
    (request: HarnessHostContextRequest<HostInvocation>) =>
      HostContext | Promise<HostContext>
  readonly logger: Logger
  readonly telemetry: TelemetryShim
}

type HostedTargetOf<Contracts extends HarnessContracts> =
  | Contracts['agents'][keyof Contracts['agents']]
  | Contracts['workflows'][keyof Contracts['workflows']]

type HostedTargetRequest<Target, HostInvocation> = Readonly<{
    target: Target
    input: HarnessValidatedTargetInput<Target>
    invokeOptions: InvokeOptions & Readonly<{ sessionId: string }>
    hostInvocation: HostInvocation
  }>

interface HostedHarnessInstance<Contracts extends HarnessContracts, HostInvocation> {
  runHosted<Target extends HostedTargetOf<Contracts>>(
    request: HostedTargetRequest<Target, HostInvocation>,
  ): Promise<RunOutcome<HarnessTargetOutput<Target>>>
  streamHosted<Target extends HostedTargetOf<Contracts>>(
    request: HostedTargetRequest<Target, HostInvocation>,
  ): Promise<HarnessTargetDispatchStream<HarnessTargetOutput<Target>>>
  close(): Promise<void>
}
```

`@purista/harness/integrator` exports `createHostOwnerToken`,
`defineHostTool(hostOwner, id, definition)`, and the hosted types above. The
same opaque owner token is attached to every host tool from one host builder
and supplied in `HarnessHostBindings`; compilation rejects any mismatch before
runtime creation. `runHosted` and `streamHosted` are the only integrator entry
points that accept `HostInvocation`. They verify the target contract identity
and receive already validated logical input before starting or reopening the
named session. They do not parse or transform the input again.

`HostInvocation` is supplied only by the host target adapter for each run. It is
opaque to Harness, absent from public `InvokeOptions`, never inspected,
serialized, persisted, or exposed to a model, and is handed only to
`createHostContext`. The returned context exists for one host-tool call and is
discarded afterward. Hosted instance config omits public `logger` and
`telemetry`; the host bindings replace those fields, and Harness derives
`Metrics` from the bound telemetry. Application callers cannot supply or
override host-only keys.

`nestedTargets.run` is scoped to the current parent run and is the only route by
which a host context may construct agent/workflow invokers. Its `callId` is
required and stable within the host-tool invocation. Harness checkpoints the
tuple `(toolCallId, callId, target kind/id, canonically validated input)`,
replays a completed result, resumes an interrupted child, and fails closed if
the id is reused with another target or input. A child interruption travels as
a library-private branded control signal that Harness catches at the tool
boundary and converts to the root `interrupted` outcome; it is never exposed as
a tool failure. Parent cancellation cancels the active child stream. Streaming
agent/workflow clients are not exposed in host-tool context in this release.
As with workflow handlers, other non-idempotent host-tool effects that precede
an interruptible child call must be protected by the Harness-provided
checkpoint `step` helper; unmanaged effects cannot be made replay-safe by the
runtime.
`checkpointStep` is the same validation, retry, persistence, replay, and error
contract as `WorkflowContext.step`. The host context factory exposes that exact
function as its typed `step`; it does not implement a second checkpoint store.

There are no generic host lifecycle callbacks in this release. Harness owns
and closes clients, processes, and internal adapters it creates. It borrows and
never closes the dispatcher, context-factory dependencies, logger, telemetry,
or opaque host invocation. Hosted shutdown first stops new Harness invocations,
then cancels or drains active runs according to the normal instance policy,
then closes Harness-owned resources. The host closes its service resources and
EventBridge only after the Harness instance has shut down.

A graph containing a host-aware tool rejects ordinary `getInstance(config)`.
The graph is instantiated by its host integration, and can be tested outside
that host only through `@purista/harness/integrator` with explicit fake host
bindings. Definitions containing only portable capabilities run unchanged in
standalone and hosted modes.

`AgentAdmission` surrounds one complete root or child agent loop:

```ts
interface AgentAdmissionRequest {
  readonly agentId: string
  readonly rootRunId: string
  readonly parentRunId?: string
  readonly depth: number
  readonly deadline?: number
  readonly signal: AbortSignal
}

interface AgentAdmission {
  acquire(request: AgentAdmissionRequest): Promise<{
    release(): void | Promise<void>
  }>
}
```

`AgentAdmission` admits one root execution tree. Calls carrying the same
`rootRunId` join the reentrant, reference-counted lease and do not consume
another global slot, which prevents a parent waiting on its child from
deadlocking at capacity one. A distributed adapter coordinates this lease
across processes. It is released only when the root tree completes, interrupts,
fails, or cancels. It contains no prompt or model content. `ModelAdmission`
continues to wrap each provider call independently.

`acquire` may reject capacity only with `AgentAdmissionRejectedError`, carrying
`retriable: boolean`, optional validated positive `retryAfterMs`, and a
content-free reason code. Any other thrown value is an adapter failure and uses
the sanitized internal-error contract.

## 10. Invocation, streaming, and approval

Definition `durable: true` enables durable invocation for that target and makes
durable Harness storage an instance requirement. A call is durable only when it
supplies `InvokeOptions.durable`; an invocation without that option remains
ephemeral. Supplying `InvokeOptions.durable` to a target that did not declare
`durable: true` fails before execution. `context.externalWait` exists only on a
workflow declared durable and rejects an ephemeral invocation before it
registers a wait. Definition `workspace: true` enables a workspace for the
target; per-run `DurableInvokeOptions.workspacePolicy` may narrow the declared
constraint but cannot create the capability. Approval-capable graph paths
independently require durable storage even when the initial call is ephemeral.

Agent and workflow invokers retain `run` for aggregate outcomes and `stream`
for an ordered, bounded portable consumer event stream. Its terminal outcome is
never dropped. Slow consumers may lose old nonterminal updates and receive an
explicit `stream.overflow` event; persisted events remain the audit source.
Operational diagnostics use a
separate observer surface. The official AI SDK UI Message Stream v1 projection
remains the initial web adapter, so standard clients need no PURISTA consumer
library. Subagent and tool activity, status, text/object updates, artifacts,
errors, and terminal outcomes retain stable correlation.

Every `ExecutionEvent` carries the event's `runId` and optional common
correlation fields `parentRunId` and `parentInvocationId`. Harness emits those
fields before a dispatcher or host observes the event; adapters preserve them
and do not invent enrichment. Child events therefore remain correlated across
process boundaries.

The compatibility contract follows the current official AI SDK APIs:
`DefaultChatTransport` consumes the UI message stream; assistant messages
render their `parts`; tool approval uses the `approval-requested` state;
clients answer through `addToolApprovalResponse({ id, approved, reason? })`;
`lastAssistantMessageIsCompleteWithApprovalResponses` may trigger the next
request; and conformance uses the official UI message stream reader. See the
[stream protocol](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol),
[tool approval guide](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage), and
[`useChat` reference](https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat).
The adapter pins a tested AI SDK major and does not claim compatibility with an
untested protocol version.

`@purista/harness-ai-sdk-ui/v1` exports the versioned boundary:

- `parseHarnessUIMessageRequest(body)` validates the standard AI SDK request
  and returns its messages, last user message, assistant message id, and any
  correlated `ToolApprovalResume` parsed from approval-response parts;
- `createHarnessUIMessageStream(events, options)` maps execution events to AI
  SDK chunks;
- `createHarnessUIMessageSseEvents(events, options)` maps execution events to
  the same ordered AI SDK chunks and returns data-only protocol records for
  hosts that own their stream writer:
  `Readonly<{ event: 'data'; data: UIMessageChunk | '[DONE]' }>`. It never
  returns encoded SSE text or bytes. The host serializes normal `data` once as
  JSON, writes `[DONE]` literally, and owns `data:` framing, separators, status,
  and headers;
- `createHarnessUIMessageStreamResponse(events, options)` returns the standard
  SSE response and v1 header; and
- `parseHarnessToolApprovalResume(message)` remains the focused approval helper.

The application maps the parsed user message to its agent's logical input; the
adapter does not guess how a structured domain schema should be populated.
Approval descriptors carry run id, interrupt id, revision, event id, approval
ids, and the stable session id required to reopen the same run. Invalid,
incomplete, stale, duplicated, or mixed-run decisions fail before invocation.

The v1 event mapping is fixed:

| Harness event | AI SDK UI v1 chunks |
| --- | --- |
| `run.started` | `start`, `start-step`, `data-status{phase:'started'}` |
| `output.text.delta` | one `text-start`, then ordered `text-delta`; `text-end` at terminal |
| `output.object.snapshot` | transient `data-output` with stable run/output id |
| `tool.input.available` | standard dynamic `tool-input-available` |
| `tool.started` | `data-status{phase:'tool-running'}` |
| successful `tool.finished` | standard dynamic `tool-output-available` |
| failed `tool.finished` | standard dynamic `tool-output-error` with sanitized text |
| terminal tool approval interrupt | standard `tool-approval-request` for every approval plus `data-status{phase:'interrupted'}` |
| `approval.responded` | standard `tool-approval-response` |
| `output.file` | standard `file` chunk with URL and media type |
| `output.progress` | `data-status{phase:'media-progress'}` |
| completed `run.finished` | completed status, `finish-step`, `finish{finishReason:'stop'}` |
| interrupted `run.finished` | interrupted status, approval chunks when applicable, `finish-step`, typed finish reason |
| failed or cancelled `run.finished` | `data-status{phase:'failed'|'cancelled'}`, close active parts, `finish-step`, typed error/cancel finish reason |

Subagent lifecycle uses the existing status data part with child correlation;
it never masquerades as a model tool. An event that the pinned adapter does not
understand is ignored and counted by content-free adapter telemetry. A missing
or duplicate terminal event is a protocol error. RAG citations remain part of
the standard retrieval tool output `{ sources: [{ title, url, excerpt? }] }`;
the reference UI renders that tool output with AI Elements `Sources`. The
adapter does not invent a custom citation protocol or claim standard
`source-url` chunks without a corresponding Harness source event.

Approval and other human input produce typed interrupted outcomes and stream
parts. They do not escape as generic errors. PURISTA maps an interrupt to the
standard success/interrupt transport contract rather than HTTP 500. Resume
uses the existing authenticated, revisioned, idempotent interrupt contract.

`RunOutcome.runId` and `ToolApprovalResume.runId` always identify the root
invocation reopened by the consumer. Each approval request also carries its
executing `agentRunId`, `agentId`, and `parentInvocationId`. Durable storage
maps that root interrupt to the exact child checkpoint. The consumer resumes
the original root target and never needs to address the child directly.

## 11. PURISTA integration

`ServiceBuilder.mountHarness(definition, policy?)` mounts exactly one Harness
definition per service version. `policy` is optional when defaults are valid.
The service instance's `ai` configuration is inferred from runtime
requirements.

Every mounted agent and workflow receives a versioned PURISTA address. All
PURISTA target calls and every workflow/subagent agent dispatch are
address-first and pass through EventBridge. Portable and host-aware model tool
handlers execute inside the receiving Harness run; PURISTA operations declared
inside a host-aware tool pass through EventBridge.

`ServiceBuilder.defineTool` creates a Harness-compatible host-aware tool while
preserving PURISTA command-builder conventions:

```ts
const lookupTransaction = supportV1ServiceBuilder
  .defineTool('lookupTransaction', {
    description: 'Load one transaction visible to the current customer.',
    input: lookupTransactionInputSchema,
    output: lookupTransactionOutputSchema,
  })
  .canInvoke(
    'Transaction',
    '1',
    'getTransaction',
    getTransactionOutputSchema,
    getTransactionPayloadSchema,
    getTransactionParameterSchema,
  )
  .canEnqueue('transactionReview', transactionReviewPayloadSchema)
  .canEmit('transactionInspected', transactionInspectedSchema)
  .setHandler(async function (context, input) {
    return context.service.Transaction['1'].getTransaction(
      { transactionId: input.transactionId },
      {},
    )
  })
```

Trusted message data supplies tenant and principal identity. Model input cannot
set or replace identity. A host tool receives the resources declared by its
owning `ServiceBuilder`; outgoing command, stream, queue, event, agent, and
workflow helpers appear only when declared on the tool builder.

`defineHostTool` from `@purista/harness/integrator` is the only integrator
factory that can create the branded host-tool value:

```ts
defineHostTool<Id, Input, Output, HostContext>(hostOwner, id, {
  description,
  input,
  output,
  async handler(context, input) { /* ... */ },
})
```

The handler is embedded in the definition but excluded from catalog and
inspection metadata. Core uses this factory internally and supplies the
run-scoped PURISTA context as an opaque generic host context; Harness never
imports or inspects PURISTA types. `ServiceBuilder.defineTool(...).setHandler()`
returns the final frozen definition, which is listed directly in an agent's
`tools` array. Users do not manually bind it during mount.

An integrator may attach an opaque host-owner brand when it creates a host
tool. Harness compares that brand during hosted graph compilation without
interpreting it. PURISTA uses the originating `ServiceBuilder` lineage as the
brand, so every host-aware tool in a mounted graph must belong to that exact
builder lineage. A mismatch fails before target registration. Portable tools
have no owner brand; a catalog containing an owned host tool is reusable only
with the matching host owner.

Mounted subagents use EventBridge even when parent and child are in the same
process. The receiver validates schemas and business guards. Direct `run` and
`stream` use `AgentAdmission` to limit concurrent complete agent loops;
provider admission separately controls provider/model/credential rate windows.
A host may expose an explicit durable `enqueue` operation that returns a typed
job receipt, but an enqueue-only queue is never hidden inside interactive
`run`, `stream`, workflow, or model-selected subagent calls.

Standalone execution also supports a distinct `AgentAdmission` port around
each root execution tree. Descendants join its reentrant lease. It can implement an in-process semaphore or a
distributed concurrency lease and receives content-free routing and lineage
metadata only. Waiting for admission is cancellable and every acquired lease is
released on completion, interruption, failure, or cancellation. `AgentAdmission`
does not replace a durable PURISTA queue, and model admission does not limit the
number of complete agent loops.

`exportServiceDefinitions` includes mounted agent/workflow contracts,
stream/update contract, queue presence, schemas, and address
metadata without prompts, Skill content, credentials, provider configuration,
or executable handlers.

## 12. File layout and generated code

AI definitions belong to their owning service version:

```text
src/service/support/v1/
├── supportV1ServiceBuilder.ts
├── supportV1Service.ts
├── command/
├── subscription/
├── stream/
└── harness/
    ├── supportHarness.ts
    ├── catalog/<catalogName>/<catalogName>Catalog.ts
    ├── agent/<agentName>/<agentName>Agent.ts
    ├── agent/<agentName>/<agentName>Agent.test.ts
    ├── workflow/<workflowName>/<workflowName>Workflow.ts
    ├── workflow/<workflowName>/<workflowName>Workflow.test.ts
    ├── tool/<toolName>/<toolName>Tool.ts
    ├── tool/<toolName>/<toolName>Tool.test.ts
    ├── skill/<skill-name>/<skillName>Skill.ts
    ├── skill/<skill-name>/SKILL.md
    ├── skill/<skill-name>/<skillName>Skill.test.ts
    ├── mcp/<serverName>/<serverName>Mcp.ts
    └── mcp/<serverName>/<serverName>Mcp.test.ts
```

Only directories needed by actual definitions exist. No service-local barrel
files are generated. Portable and host-aware tools share the `tool` location;
their factory import makes ownership explicit. Tests are colocated.

Shared definitions live in an explicitly named package or domain module.
Service files do not import another service builder. Cyclic definition imports
are forbidden and graph validation provides a second fail-fast check.

The PURISTA CLI adds clean generators for `harness`, `agent`, `workflow`,
`tool`, `skill`, and `mcp`. `purista add agent` is the beginner entrypoint: it creates
the service-owned folders, one minimal string agent, a Harness definition when
missing, the mount, and a deterministic test. Agent definitions always support
aggregate and streaming execution; only an optional HTTP stream projection is
a generator choice.

The clean first-release CLI contract is intentionally narrow:

- common flags are `--service`, `--service-version`, `--description`, and the
  existing interactive/non-interactive mode flags;
- `add harness [name]` defaults to the lower-camel service name, creates
  `harness/<serviceName>Harness.ts`, and mounts it when the final service file
  has the canonical generated composition; it generates no empty-Harness test;
- `add agent <name>` creates a minimal string agent and test, creates the
  Harness when absent, mounts it, and adds the agent root;
- `add workflow <name>` creates a string-input/string-output workflow and test,
  creates and mounts the Harness when absent, and adds the workflow root;
- `add tool <name> --kind portable|purista` creates one typed string tool and
  test but does not add it as a Harness root; an agent/workflow reference brings
  it into the graph; non-interactive mode requires `--kind`;
- `add skill <kebab-name> [--runtime node|python|shell]` creates the definition,
  `SKILL.md`, runtime list, and validation test but does not add it as a root;
- `add mcp <name> --tool <localName> --remote-name <remoteName>` creates one
  server definition with a typed string tool and contract test but does not add
  it as a root; both tool flags are required in non-interactive mode; and
- `--http none|command|stream` belongs to `add agent` and defaults to `none`.

`--http command` generates protected command target `run<AgentPascal>` at
`command/run<AgentPascal>/run<AgentPascal>CommandBuilder.ts`, exposed as
`POST ai/<agent-kebab>`. Its JSON payload is `{ input: string, sessionId?:
string }`; it declares the address-first agent contract and returns the
aggregate `RunOutcome`. Its colocated test mocks the address-first agent client
and verifies input/session mapping and interrupted outcomes. `--http stream` generates protected stream target
`stream<AgentPascal>` at
`stream/stream<AgentPascal>/stream<AgentPascal>StreamBuilder.ts`, exposed at the
same POST path. It accepts the standard AI SDK UI request schema, parses it with
`parseHarnessUIMessageRequest`, invokes the mounted agent stream with the
stable session and optional resume, and writes the v1 SSE events. Its colocated
test verifies message mapping, v1 headers/events, cancellation, and approval
resume. The distinct
wrapper target name cannot collide with the mounted agent id. Public access
requires the user to add `.makeEndpointPublic()` explicitly.

An existing path or duplicate id fails before modification. Canonical Harness
files are updated with AST edits. For a noncanonical final service composition,
the CLI performs no partial graph change and reports the exact files and
composition statement the user must add. It never regex-rewrites arbitrary
code. Generated dependencies come from one versioned CLI release package map.
The v4 release map uses published `@purista/harness@^4.0.0`; adding the first
agent in the standard starter also adds `@purista/harness-openai@^4.0.0`, an
`OPENAI_API_KEY` entry to `.env.example`, and the canonical `ai.model`
bootstrap. Tests use `@purista/harness/testing` and never require credentials.
The stream projection additionally adds
`@purista/harness-ai-sdk-ui@^4.0.0` and its tested `ai@^7.0.0` peer.

## 13. Representation ownership

| Semantic value | Canonical owner | Valid projections | Forbidden duplication |
| --- | --- | --- | --- |
| tool/Skill/MCP/agent/workflow definition | branded immutable Harness definition | catalog view, inspection row, provider tool schema | host-owned structural copies or mutable registries |
| target input/output contract | `HarnessTargetContract` with Standard JSON Schemas | PURISTA exported target, JSON Schema/OpenAPI metadata | importing another service builder for schemas |
| aggregate execution | `RunOutcome<Output, Interrupt>` | EventBridge command response, HTTP JSON response | adapter-specific outcome unions |
| progressive execution | `ExecutionEvent<Output>` | EventBridge stream frame, AI SDK UI v1 chunk, persisted audit event | provider-native SSE as the portable contract |
| approval | `ToolApprovalInterrupt` and `ToolApprovalResume` | AI SDK approval parts and descriptor | generic thrown error or UI-only approval state |
| child dispatch | `HarnessTargetDispatchRequest` and terminal `RunOutcome` | local dispatcher stream, PURISTA EventBridge stream | direct JavaScript child invocation |
| runtime need | `RuntimeRequirements` | exact `HarnessInstanceConfig`, PURISTA `ai` config, inspection | hand-maintained duplicate capability lists |
| background delivery | host queue receipt | PURISTA enqueue client and worker call | transparent queueing inside `run` or `stream` |

Mappings are one-way boundary adapters and preserve stable ids, schema meaning,
lineage, and terminal status. Provider request/response values, EventBridge
messages, persisted records, and AI SDK chunks are boundary representations;
none becomes a second authoring model.

## 14. Testing and release

Required verification includes factory inference and negative type tests;
catalog composition, reuse, conflict, foreign-reference, and cycle tests;
default and structured agent execution; native/host/MCP tool conformance; Skill
runtime and permission behavior; subagent dispatch, identity, budgets,
cancellation, admission, policy isolation, and streaming; workflow context and
durability; instance binding and ownership; PURISTA mount/EventBridge/guard/
queue/export/HTTP/interrupt behavior; CLI snapshots and generated-project
tests; and all maintained examples, docs, API declarations, website, Skills,
package-boundary checks, and clean-removal scans.

The release removes rather than deprecates inline builder registration,
`.define()`, `.build()`, `defineHarnessModule`, `HarnessModule`,
`HarnessModuleBuilder`, public `BuilderState` authoring, custom agent handlers,
string-based tool/Skill/subagent allowlists, user-facing manual host-tool mount
binding for `ServiceBuilder.defineTool`, and every compatibility shim or stale
recommended example. Migration documentation contains only a concise source
rewrite; no runtime migration code is added.

Completion covers all Harness packages and examples, PURISTA Core, Hono and AI
SDK UI adapters, CLI, `create-purista`, starter, Voyage consumers, banking
tutorial source, handbook, API reference, migration pages, public knowledge,
canonical skills and mirrors, package-install verification, and scans for
removed patterns.

## 15. Acceptance criteria

1. A string agent can be defined, instantiated, and streamed with one agent
   definition, one Harness definition, and one model binding.
2. Portable definitions run unchanged standalone and under PURISTA. A graph
   containing host-aware tools retains the same definitions but requires its
   host integrator bindings and fails ordinary standalone instantiation.
3. Adding a typed tool, Skill, subagent, Guardrail, workflow, admission policy,
   or durable adapter is additive and retains exact inferred types. Durable
   queueing is a host-owned explicit enqueue path.
4. Availability never grants access, and no context exposes a registry lookup
   escape hatch.
5. Agents are standard model loops; arbitrary orchestration is a workflow.
6. Skill scripts remain untyped CLI assets unless deliberately wrapped as
   typed tools; runtime requirements do not grant execution or install software.
7. Subagents use typed contracts and dispatcher execution; mounted calls always
   traverse EventBridge.
8. Catalog and direct composition share one compiler, recursively collect typed
   dependency closure, and reject foreign references, conflicts, incompatible
   capabilities, and cycles.
9. Aggregate, streaming, approval, artifact, structured response, and AI SDK UI
   Message Stream conformance tests pass.
10. No removed symbol or recommended pattern remains outside explicit migration
    documentation and negative audit fixtures.
11. All maintained packages, examples, generated projects, docs, tutorials,
    Skills, audits, and full repository verification commands pass.
