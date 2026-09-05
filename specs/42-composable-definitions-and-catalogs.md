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

Every public Harness schema boundary accepts and produces `JsonValue` at the
TypeScript level. Schema validators and transforms must be pure,
deterministic, and side-effect free. Runtime validation also rejects any
non-JSON validated result. This is required because target input/output, tool
arguments/results, events, checkpoints, and hosted dispatch can cross process
boundaries. A schema that transforms JSON into `Date`, a class instance, or
another non-JSON value is not a valid Harness definition. Definition factory
option types reject a schema whose inferred input or output is not
JSON-compatible; target inference additionally intersects both sides with
`JsonValue` so no non-portable value appears in an invocation contract.

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
    ? InferIn<Input> & JsonValue
    : never

type HarnessValidatedTargetInput<Target> =
  Target extends HarnessTargetContract<any, any, infer Input, any, any, any>
    ? Infer<Input> & JsonValue
    : never

type HarnessTargetOutput<Target> =
  Target extends HarnessTargetContract<any, any, any, infer Output, any, any>
    ? Infer<Output> & JsonValue
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
  eventId: string
  sequence: number
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
`interrupts: ['tool-approval']` because its declared permission or governance
policy may require approval for selected capabilities. A workflow has `updates: 'none'`: it may
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
completed live/public `run.finished` outcome. Its spec 12 persisted projection
is the strict content-free `PersistedRunFinishedPayload`: output and interrupt
content are absent, while failed and cancelled outcomes retain only their
canonical sanitized `SerializedError`. Terminal replay reconstructs the public
event from the validated persisted envelope and authoritative terminal
`RunRecord`; it never casts a persisted payload to `ExecutionEvent`.
`approval.responded.approved` is true only
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

`sequence` is a positive safe integer scoped to the event's own `runId`. It
starts at `1` for `run.started` and increases by exactly one for every logical
event, including a synthesized `stream.overflow` and the terminal event.
`eventId` is `event_` plus lowercase SHA-256 of the canonical JSON tuple
`['harness.event.v1',runId,sequence,type]`. The same logical event retains both
values across persistence retry and process resume. `nextEventSequence` in a
checkpoint is exactly the next unused value. Storage append accepts an exact
duplicate idempotently and rejects a changed duplicate, a sequence gap, or a
non-increasing new event before writing any member of the batch. Live delivery
uses the already assigned values and never allocates another sequence.

The v4 inventory removes `skill.started` and `skill.finished`. Skills are inert
guidance packages, not executable calls; a script deliberately wrapped as a
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
`bash` contributes `sandbox.exec`, `grep` contributes `sandbox.text_search`,
and `read`, `write`, `edit`, `glob`, and `list` contribute `sandbox.fs`.
Agent permissions constrain selected tools but never
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
tool exists exactly once. Undeclared remote tools are ignored and never enter
the catalog, an agent's model-facing tool map, or any callable registry. This
lets an upstream server add unrelated tools without changing the explicitly
selected local surface. Declared and discovered input schemas are projected to
the supported JSON Schema subset, remove only annotation keys `title`,
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

One runtime bundle is initialized per declared server, in deterministic server-id
order. A bundle contains one client and transport; a stdio bundle contains one
process even when the server exposes several selected tools. Instance creation
connects, lists, and validates every declared server before it resolves. A
server initializer closes everything it created if that server fails. If a
later server fails, already initialized bundles close in reverse creation
order.

H4-008 creates one private Harness-instance ULID and passes the Harness name,
that instance id, the initialization signal, and resolved `toolTimeoutMs` to
the MCP initializer. The same timeout bounds initialization connect/list
operations; normal calls remain bounded by the common tool pipeline. A stdio
binding uses the existing session scope with this synthetic instance-owned
identity:

```ts
const owner = {
  namespace: `${harnessName}.mcp`,
  id: mcpServer.id,
  instanceId: harnessInstanceId,
}

const scope = {
  owner,
  partition: { kind: 'shared' },
  lifetime: 'session',
}
```

The initializer calls `registerOwner` in `create` mode, opens the scope in
`create` mode, verifies the returned session is spawn-capable, and only then
starts the MCP process. This infrastructure owner has no principal or tenant
identity. Closing a stdio bundle first performs its single idempotent protocol
close, which closes the client and its owned transport/process. It then closes
the sandbox attachment and finally terminates the synthetic scope with
`reason: 'session_closed'`. Every close step and the complete bundle close are
idempotent. The supplied sandbox adapter itself is borrowed and is never
closed. H4-008 owns the initialized bundles and closes each bundle once during
instance shutdown.

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
the adapter declares no Skill runtimes. Runtime metadata is explicit and is
never inferred from `PATH`, the Harness Node.js process, an executable
allowlist, or another host property. `LocalDirectorySandboxOptions` and
`FakeSandboxOptions` therefore accept an optional
`runtimes: readonly SkillRuntimeId[]`; omission produces a frozen empty array,
and supplied values are validated, copied, lexicographically sorted, and
frozen; duplicates are rejected. A nonempty local or fake runtime list is valid
only for an exec-capable adapter configuration. `inMemorySandbox()` reports no runtimes.
`bashSandbox()` reports `['shell']`, plus `python` when its own `python: true`
configuration guarantees that runtime; it never infers `node`.

The sandbox capability vocabulary includes `sandbox.readonly_mount`.
`SandboxSessionFor<C>` exposes `mountReadOnly` only when that literal
capability is present. A Skill with omitted or empty `runtimes` is
guidance-only: it is available through the scoped reader below and is not
mounted. A Skill with at least one runtime contributes its exact logical
runtime ids plus `sandbox.fs` and `sandbox.readonly_mount`. The graph-level
sandbox binding then requires `runtimes`, and instance validation requires all
three parts of that compiled requirement. A Guardrail-only `skillRuntimes`
requirement contributes its runtime ids but does not contribute the mount
capabilities because there is no Skill package to mount.

Runtime metadata and a read-only mount never grant process execution,
filesystem mutation, environment, or network permission. An adapter may
declare `sandbox.readonly_mount` only when `write`, `remove`, later mounts, and
sandbox-executed processes cannot mutate the mounted tree. Runtime-bearing
Skills are mounted at `/skills/<skill-id>` through `mountReadOnly` before the
first provider call. Files receive no inferred executable bit; an allowed
runtime command interprets a script. An exec-enabled local sandbox must not
declare `sandbox.readonly_mount` unless it enforces immutability against child
processes rather than relying only on host file modes.

`defineSkill` validates the id grammar synchronously. Instance initialization
accepts only a `file:` directory URL, loads an immutable byte snapshot, loads
`SKILL.md`, and validates its YAML frontmatter before `getInstance()` resolves.
The accepted frontmatter follows the current
[Agent Skills specification](https://agentskills.io/specification) field set:

- required `name`: 1-64 lowercase ASCII letters, digits, or hyphens, without a
  leading, trailing, or consecutive hyphen, and equal to both the definition
  id and Skill directory basename;
- required `description`: a nonempty string of at most 1,024 characters;
- optional `license`: a nonempty license name or reference to a bundled license
  file;
- optional `compatibility`: a nonempty string of at most 500 characters;
- optional `metadata`: a mapping from string keys to string values; and
- optional experimental `allowed-tools`: a nonempty space-separated string.

Unknown frontmatter fields fail initialization. `allowed-tools` is retained as
Skill content only. It does not select a tool, modify agent permissions, skip
governance or approval, or grant any capability.

The loader uses `lstat` and rejects a symlink or non-file/non-directory entry,
including a symlink supplied as the Skill root. Paths may contain at most 512
UTF-8 bytes and must be relative POSIX paths with no empty, `.`, `..`,
backslash, absolute, or control-character segment. One Skill may contain at
most 5,000 entries and 100 MiB of file data. `SKILL.md` must be valid UTF-8 and
at most 256 KiB. The loader checks cancellation between filesystem operations,
does not retain file bodies in errors or telemetry, and reads each file only
into the immutable snapshot used by both mounting and the reader.

Loader and mount failures use `SkillManifestError` with one of these stable,
content-free reasons: `invalid_skill_url`, `directory_missing`,
`missing_skill_md`, `invalid_frontmatter`, `missing_description`,
`invalid_name`, `name_mismatch`, `unsafe_skill_entry`, `invalid_skill_path`,
`invalid_skill_encoding`, `skill_file_too_large`, `scan_limit_reached`, or
`readonly_mount_unsupported`. Metadata may identify the Skill id, configured
directory, and relative path, but never includes file content. The clean-break
implementation removes former discovery, shadowing, trust, and registry error
reasons that no longer describe a v4 operation.

Skill definitions do not enumerate scripts and do not declare script input or
output schemas, hashes, review state, or per-script policies. `SKILL.md`
documents script paths and CLI use. Scripts in a runtime-bearing Skill are
mounted inert and read-only.
Declaring a Skill or runtime does not grant process execution, environment,
filesystem write, or network access. Those capabilities remain explicit agent
permissions enforced by the sandbox and decision pipeline.

When an application needs a stable typed script interface, it wraps the script
in a native or host-aware tool. Tool schemas then validate the supported
boundary; arbitrary CLI use does not pretend to have a structured contract.

The standard loop receives one Harness-owned model tool named `read_skill` when
the agent selects at least one Skill. The underscore is reserved by the Harness
and cannot collide with lower-camel portable, built-in, MCP-local, or subagent
names. It is not a public definition, is not added to the catalog, and cannot
be selected directly. Its per-agent input and output schemas are exact:

```ts
type ReadSkillInput = {
  skill: SelectedSkillId
  path?: string // default: 'SKILL.md'
}

type ReadSkillOutput = {
  skill: SelectedSkillId
  path: string
  content: string
}
```

`skill` is an enum of that agent's selected Skill ids. `path` follows the
loader path rules above and resolves only against the immutable snapshot. The
reader performs no filesystem access. It returns only valid UTF-8 files of at
most 256 KiB; binary or larger resources remain mountable but are not returned
to the model. Selecting a Skill adds `tool_use` to the agent's model
requirements but does not add the broad built-in filesystem `read` tool.

Before the first provider call, H4-005 gives the model a protected discovery
block for the Skills selected by that agent. The block is a Harness-owned
system instruction placed after the application's `instructions` and before
conversation history and the current user input. It serializes a JSON array of
`{ name, description }` values sorted lexicographically by Skill id. These
values are untrusted discovery metadata rather than instructions. The block
tells the model to select only a listed Skill when it is relevant, activate it
by calling `read_skill` with that Skill name and `path: 'SKILL.md'`, and use
`read_skill` again for relative text files referenced by `SKILL.md`. It also
states that Skill content and `allowed-tools` cannot expand the agent's tools,
permissions, sandbox capabilities, or other authority. An agent with no Skills
receives neither this block nor `read_skill`. This deterministic protected
block is the first disclosure tier; reading `SKILL.md` and its referenced text
files is the second tier. Skill file bodies are never placed in the initial
prompt.

`read_skill` receives a synthesized default agent permission of `allow`, while
the agent's declared governance may still deny or require approval and its
Guardrails may allow, block, or transform at their declared phases. It uses
the same exposure, transform, input validation, policy, approval, execution,
output validation, telemetry, event, timeout, and cancellation pipeline as
native, built-in, MCP, and host-aware tools. There is no public direct-call
path that bypasses this pipeline.

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
  governance: ({ native, rule }) => ({
    policies: [native({
      id: 'transaction-policy',
      rules: [rule({
        id: 'review-large-lookup',
        tools: ['getTransaction'],
        effect: 'require_approval',
      })],
    })],
  }),
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
| `skills` | readonly Skill references | `tool_use` and scoped reader; runtime-bearing Skills add runtimes, `sandbox.fs`, and `sandbox.readonly_mount` |
| `guardrails` | `AgentGuardrailsBinding<Requirements>` | its exact declared requirements |
| `permissions` | existing `AgentPermissions` | restriction only; `require_approval` adds durable storage |
| `governance` | `AgentGovernanceInput<Tools, Skills, Subagents>` | policies are scoped to this agent's complete model-facing binding map; any declared `require_approval` effect adds durable storage |
| `subagents` | typed agent map | graph closure and delegation tools |
| `loop` | closed positive integer limits | none |
| `memory` | `AgentMemoryPolicy` | memory capabilities and declared model aliases |
| `sandbox` | existing `SandboxPolicy` | partition and sharing policy only |
| `workspace` | optional literal `true` | workspace binding |
| `durable` | optional literal `true` | durable Harness storage |

`model` is a lower-camel string literal `ModelAliasId` that identifies a
runtime requirement. `ModelAlias` remains the concrete provider/model runtime
binding and is never accepted by `defineAgent`.

Governance is authored on the agent because model-facing tool exposure and
execution policy are agent-specific. The v4 type projection is:

```ts
type ExplicitAgentToolMap<Tools extends readonly AnyToolDefinition[]> = Readonly<{
  [Tool in Tools[number] as Tool['id']]: Tool
}>

type NormalizeTools<Tools> =
  Tools extends readonly AnyToolDefinition[] ? Tools : readonly []
type NormalizeSkills<Skills> =
  Skills extends readonly SkillDefinition[] ? Skills : readonly []
type NormalizeSubagents<Subagents> =
  Subagents extends AgentSubagentMap ? Subagents : Readonly<Record<never, never>>
type ReferencedAgent<Reference> =
  Reference extends Readonly<{ agent: infer Agent extends AnyAgentDefinition }>
    ? Agent
    : Reference extends AnyAgentDefinition ? Reference : never

type ReadSkillGovernanceTool<Skills extends readonly SkillDefinition[]> =
  Skills extends readonly [] ? Readonly<Record<never, never>> : Readonly<{
    read_skill: Readonly<{
      id: 'read_skill'
      input: Schema<ReadSkillInput>
      output: Schema<ReadSkillOutput>
    }>
  }>

type SubagentGovernanceToolMap<Subagents extends AgentSubagentMap> = Readonly<{
  [Name in keyof Subagents]: Readonly<{
    id: Name
    input: ReferencedAgent<Subagents[Name]>['input']
    output: ReferencedAgent<Subagents[Name]>['output']
  }>
}>

type AgentModelToolMap<Tools, Skills, Subagents> = Readonly<
  ExplicitAgentToolMap<NormalizeTools<Tools>>
  & ReadSkillGovernanceTool<NormalizeSkills<Skills>>
  & SubagentGovernanceToolMap<NormalizeSubagents<Subagents>>
>

type AgentGovernanceInput<Tools, Skills, Subagents> =
  | GovernanceConfig<AgentModelToolMap<Tools, Skills, Subagents>>
  | ((helpers: GovernanceDefinitionHelpers<
        AgentModelToolMap<Tools, Skills, Subagents>
      >) => GovernanceConfig<AgentModelToolMap<Tools, Skills, Subagents>>)

interface GovernancePolicyEvaluator<
  ToolMap extends Readonly<Record<string, AnyToolDefinition>>,
> {
  readonly id: string
  readonly version?: string
  readonly engine?: string
  readonly effects: readonly GovernanceEffect[]
  evaluate(
    context: GovernanceContext<ToolMap>,
  ):
    | GovernanceDecision
    | readonly GovernanceDecision[]
    | undefined
    | Promise<
        GovernanceDecision
        | readonly GovernanceDecision[]
        | undefined
      >
}
```

`GovernanceConfig`, `GovernanceContext`, and
`GovernanceDefinitionHelpers` keep the decision semantics from spec 37, but
their v4 generic is the exact readonly tool map rather than removed
`BuilderState`. A helper callback is evaluated synchronously by `defineAgent`
and its frozen result becomes the agent's governance snapshot. It cannot access
providers, adapters, credentials, runtime registries, or host invocation data.
The former Harness-builder `.governance(...)` method is removed.
The map contains every explicit portable, built-in, MCP, or host tool, plus the
conditional generated `read_skill` binding and every subagent delegation name.
For a subagent key its input/output are the referenced child agent schemas;
`read_skill` uses the exact schemas in section 4. Native rule and exposure
selectors use readonly literal keys from this complete map. Unknown keys fail
at compile time and runtime configuration validation. Runtime
`GovernanceContext.toolId` remains the selected literal key and its `input`
remains correlated to that binding's schema. These keys configure a frozen
policy; they do not expose a runtime registry or dynamic lookup path.

Every external `GovernancePolicyEvaluator` declares a nonempty frozen
`effects: readonly GovernanceEffect[]` capability list. Native policies derive
that list from their configured rule effects. Returning an effect absent from
the evaluator's declaration is `DecisionEvaluationError{failureKind:
'invalid_result'}`. The requirement compiler sets
`storage.durable:true` whenever agent permissions, a native rule, or an external
evaluator declaration contains `require_approval`, regardless of whether a
predicate will match on a particular run. Runtime and host bindings cannot add
another governance policy or return undeclared `require_approval`; PURISTA
business authorization remains in service guards. This makes approval storage
and revision requirements decidable entirely from the frozen graph.

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
capabilities. Permission/governance approval paths, Guardrails that explicitly
declare `requirements.durable:true`, and delegated interruption require durable
storage so resume can survive process boundaries. There is no
evaluation definition or inferred evaluation runtime requirement in this
composition contract.

An agent owns configuration only: model alias, input/output contract,
instructions, tools, Skills, Guardrails, permissions, governance, subagents, sandbox
policy, and bounded declarative loop settings. An agent has no general
`handler`. Custom control flow is a workflow. Per-step agent hooks are not part
of this release; adding them later requires a separate pure, typed contract.

Tool, Skill, and subagent properties accept typed definition references, not
manually synchronized string ids. The Harness compiler converts them into
provider-facing names and schemas.

If `input` is omitted, it is a string. If `output` is omitted, the agent is a
text agent and its final output is a string. Supplying `output` makes the agent
a structured agent. If `model` is omitted, the alias is `primary`. `run`
aggregates with `text` or `object`; `stream` always uses the provider's real
`textStream` or `objectStream` operation. Text agents produce text deltas and
structured agents produce object snapshots. Agent authors do not configure a
separate `updates` or buffering mode.

Output disclosure is derived only from the final-output safety boundary. When
the agent has no `beforeOutput` Guardrail, `stream` relays text deltas or object
snapshots from every provider step immediately in provider order. These values
are provisional UI updates: they are never added to canonical assistant
history and never contribute to `RunOutcome.output`. A provider step that asks
for tools may therefore show ordinary provider output while tool/status events
continue live. Only the terminal no-tool step supplies the final candidate and
canonical output.

When the agent has `beforeOutput`, `stream` still consumes the real provider
stream and still emits tool, policy, approval, and status activity, but it
suppresses assistant output from every step. Tool-turn content is discarded.
After the terminal candidate passes `beforeOutput` and the output schema, the
Harness emits one complete `output.text.delta` or one complete
`output.object.snapshot`. Tool, Skill, MCP, or subagent availability alone
never selects buffering, because doing so would silently remove normal live
chat and RAG behavior.

For both invocation modes, `RunOutcome.output` is the validated terminal step
only. In a text stream the terminal candidate is the concatenation of that
step's ordered deltas. In an object stream it is the final object on that
step's finish chunk. A provider stream must contain exactly one finish chunk,
no chunks after it, and a final object in object mode. Violations fail with
`ValidationError{where:'model_response'}`. `afterModel` and final output-schema
validation may terminate an unguarded stream after provisional content has
already reached the consumer; only `beforeOutput` is a pre-disclosure output
safety boundary. Existing stream ids plus `model.completed` delimit provider
turns for the AI SDK UI projection.

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
provides its input schema, output schema, and stable identity. The generated
tool description is the referenced agent's non-empty `description` when one is
present; otherwise it is exactly `Delegate to the "<agent-id>" agent.`. A long
form may override only the parent-facing description with a non-empty string:

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
model execution. Trusted identity, trace, session/run ancestry, cancellation,
deadlines, and idempotency propagate. `HarnessIdentity` is the one
provider-neutral identity shape already owned by Harness.
`HarnessTraceContext` is the existing W3C carrier normalized to the frozen
shape `{traceparent:string,tracestate?:string}` using the existing validation
and `INVALID_TRACE_CONTEXT` behavior.
`HarnessTargetDispatcher` is a trusted runtime/integrator SPI, not application
ingress. At the root boundary Harness applies `normalizeHarnessIdentity`,
copies and freezes the result, and binds it to the session exactly once. Every
descendant receives the same normalized identity values; dispatchers cannot widen,
replace, or derive it from target input. A standalone application is the trust
boundary for the root identity it supplies. A PURISTA dispatcher constructs it
only from authenticated EventBridge sender identity; transported target input
and caller-controlled message data can never set or replace it. Hosted resume
must match the identity already bound to the stored session before reading or
executing a continuation.

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
    identity?: HarnessIdentity
    trace?: HarnessTraceContext
    deadline?: number
    idempotencyKey?: string
    signal: AbortSignal
  }>
}>

interface HarnessTargetDispatchStream<O> extends AsyncIterable<ExecutionEvent<O>> {
  cancel(reason?: string): Promise<void>
}

interface HarnessTargetDispatcher {
  assertTarget(target: AnyHarnessTargetContract): void
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

`assertTarget` performs that exact hidden-identity membership check without
opening a stream, resolving an address, allocating an id, or producing any
other effect. It uses the same immutable table and canonical unknown-target
error as `open`; `open` still repeats the check at its own boundary. Durable
callers invoke `assertTarget` before checkpoint lookup so replay cannot return
saved output for an undeclared capability.

`open` is the single nested-target primitive. The caller consumes the stream to
its undroppable terminal outcome and relays child events with their child run
id and parent invocation id. A child gets isolated conversation history and a
fresh child session derived from the parent session; ancestry remains metadata.
Only remaining delegation depth crosses the dispatch boundary. Every agent has
`loop.maxDepth`; every workflow has `maxDepth`, using the same default when it
is omitted. Agent `loop.maxDepth` and workflow `maxDepth` each override the
Harness `defaults.maxDepth`. A root agent or workflow starts at depth zero with its configured
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
`maxSteps`, `maxToolCalls`, `maxSubagentCalls`, and exhausted delegation depth
are checked before starting
the operation that would exceed them and fail with
`AgentLoopBudgetError{code:'AGENT_LOOP_BUDGET_EXCEEDED',category:'validation',retriable:false}`.
Its content-free metadata reason is respectively `max_steps`,
`max_tool_calls`, `max_subagent_calls`, or `max_depth`, with the configured
limit. For `max_depth`, `limit` is the current invocation's absolute effective
depth ceiling, computed once as `depth + remainingDepth`; dispatch is never
opened when `remainingDepth` is zero. Tool-call
batch scheduling preserves provider call order among waiting entries.
`maxParallelToolCalls` bounds every executable tool occurrence;
`maxParallelSubagents` additionally bounds the subset whose binding kind is
`subagent`. A subagent starts only after it owns capacity from both semaphores.
Neither concurrency limit rejects work under normal load; excess calls wait
within the inherited deadline and cancellation signal.
These agent-loop limits belong only to that agent invocation. They never count
a workflow's direct agent calls, child-task starts, or continuable turns.
Workflow-owned agent-call budgets are defined separately in section 7. When a
workflow-called agent delegates, the outer workflow call consumes one workflow
slot while the child agent independently enforces its own subagent limits.
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

The generated subagent binding consumes exactly one `run.finished` event from
the child stream after relaying every child event in order. A missing or
duplicate terminal event is `ValidationError{where:'model_response'}`. Terminal
outcomes project as follows:

- `completed` returns the already validated child output as the tool result;
- `interrupted` throws `HarnessChildTargetInterruption` with the child
  invocation id and outcome;
- `cancelled` throws `OperationCancelledError` with the fixed message
  `Subagent execution was cancelled.`, metadata `{scope:'agent'}`, and the
  transported `SerializedError` as its cause, so cancellation terminates the
  parent operation rather than becoming model-visible tool failure; and
- `failed` throws `ToolError` with the fixed message `Subagent execution
  failed.`, metadata `{tool_id:<provider-facing-subagent-name>,
  tool_kind:'subagent'}`, and the transported `SerializedError` as its cause.
  Transported error fields are never reconstructed as trusted local error
  classes or copied into top-level metadata.

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
handler with the same `callId`, target, and canonically equivalent JSON wire
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

The workflow context is conditional on the definition's literal durability.
The `Durable` generic is the exact `true | undefined` value inferred by
`defineWorkflow`; it is not widened to `boolean`:

```ts
type WorkflowExternalWait<Durable extends true | undefined> =
  Durable extends true
    ? Readonly<{
        externalWait: Readonly<{
          wait(request: ExternalWaitRequest): Promise<ExternalWaitResolved>
        }>
      }>
    : Readonly<Record<never, never>>

type WorkflowContext<
  Input extends ModelSchema,
  Output extends ModelSchema,
  Agents extends WorkflowAgentMap | undefined,
  Models extends WorkflowModelMap | undefined,
  ChildTaskSandboxGroups extends readonly string[],
  Durable extends true | undefined,
> = WorkflowContextBase<
  Input,
  Output,
  Agents,
  Models,
  ChildTaskSandboxGroups
>
  & WorkflowExternalWait<Durable>
```

`WorkflowOptions.handler` binds this same `Durable` generic. A non-durable
workflow therefore has no `externalWait` property at compile time. A durable
definition exposes it, while an invocation of that definition without
`InvokeOptions.durable` rejects `externalWait.wait(...)` before registering a
wait.

The retained bounded child-task surface is exact. It never allows a workflow
to override the selected agent's model. A workflow may declare an exact
`childTaskSandboxGroups` tuple and use only that vocabulary for the spec 36
child-task sandbox-policy override:

```ts
type ChildTaskContextPolicy = 'isolated'
type ChildTaskMode = 'one_shot' | 'continuable'

interface ChildTaskDescriptor {
  readonly id: string
  readonly parentRunId: string
  readonly sessionId: string
  readonly workflowId: string
  readonly workflowInvocationId: string
  readonly callId: string
  readonly agentId: string
  readonly modelAlias: string
  readonly contextPolicy: ChildTaskContextPolicy
  readonly mode: ChildTaskMode
  readonly createdAt: string
}

interface ChildTaskStatus {
  readonly descriptor: ChildTaskDescriptor
  readonly status: 'running' | 'succeeded' | 'failed' | 'cancelled'
  readonly finishedAt?: string
  readonly error?: SerializedError
}

interface ChildTaskHandle<Output> {
  readonly id: string
  result(): Promise<Output>
  status(): Promise<ChildTaskStatus>
  cancel(reason?: string): Promise<void>
}

interface ContinuableChildTaskHandle<Input, Output>
  extends ChildTaskHandle<Output> {
  send(input: Input): Promise<Output>
  close(): Promise<Output | undefined>
}

type ChildTaskStartOptions<Groups extends readonly string[]> = Readonly<{
  callId: string
  idempotencyKey?: string
  timeoutMs?: number
  context?: 'isolated'
  mode?: 'one_shot'
  sandbox?: SandboxPolicy<Groups[number]>
}>

type ContinuableChildTaskStartOptions<
  Groups extends readonly string[],
> = Readonly<{
  callId: string
  timeoutMs?: number
  context?: 'isolated'
  mode: 'continuable'
  sandbox?: SandboxPolicy<Groups[number]>
}>

interface WorkflowAgentCallLimits {
  readonly maxCalls?: number
  readonly maxParallel?: number
}

interface WorkflowChildTasks<
  Agents extends WorkflowAgentMap | undefined,
  ChildTaskSandboxGroups extends readonly string[],
> {
  start<K extends keyof NonNullable<Agents>>(
    agent: K,
    input: NonNullable<Agents>[K]['$infer']['input'],
    options: ContinuableChildTaskStartOptions<ChildTaskSandboxGroups>,
  ): Promise<ContinuableChildTaskHandle<
    NonNullable<Agents>[K]['$infer']['input'],
    NonNullable<Agents>[K]['$infer']['output']
  >>
  start<K extends keyof NonNullable<Agents>>(
    agent: K,
    input: NonNullable<Agents>[K]['$infer']['input'],
    options: ChildTaskStartOptions<ChildTaskSandboxGroups>,
  ): Promise<ChildTaskHandle<NonNullable<Agents>[K]['$infer']['output']>>
}

type WorkflowContextBase<
  Input extends ModelSchema,
  Output extends ModelSchema,
  Agents extends WorkflowAgentMap | undefined,
  Models extends WorkflowModelMap | undefined,
  ChildTaskSandboxGroups extends readonly string[],
> = Readonly<{
  input: Infer<Input> & JsonValue
  agents: WorkflowAgentInvokers<Agents>
  models: WorkflowModelHandles<Models>
  logger: Logger
  telemetry: TelemetryShim
  metrics: Metrics
  signal: AbortSignal
  runId: string
  sessionId: string
  metadata: Readonly<Record<string, JsonValue>>
  step: HarnessCheckpointStep
  fanOut: <Item, Result>(
    items: readonly Item[],
    worker: (item: Item, index: number) => Promise<Result>,
    options?: Readonly<{ concurrency?: number }>,
  ) => Promise<Result[]>
  childTasks: WorkflowChildTasks<Agents, ChildTaskSandboxGroups>
}>
```

`context.childTasks.start(...)` has typed overloads for those two option
shapes and only accepts keys from the workflow's declared `agents` map. Its
optional sandbox policy follows spec 36 precedence. A group policy accepts
only a literal from the workflow's `childTaskSandboxGroups`; `inherit` and
`private` need no group declaration. The declared tuple contributes required
sandbox groups to the graph, but the runtime host must still configure them.
One-shot tasks may outlive a successful handler return. Continuable tasks are
in-process only and reject any invocation with `InvokeOptions.durable` before
creating the task. A durable one-shot start requires a non-empty
`idempotencyKey`; its effective task id derives from the durable parent run id
and that key. `callId` identifies the logical start within one handler
execution and is still required independently of the durable task id.
H4-007 owns the typed handles, bounded execution, task records, and dispatcher
calls. H4-008 binds the content-free `session.childTasks.get()` and `list()`
facade and owns shutdown coordination around those H4-007 task records.

Child tasks do not add a second approval/resume protocol. Before creating a
task, reserving budget, writing a run record, or emitting an event, the workflow
runtime reads exactly
`compiledGraph.approval.agents[selectedAgent.id].reachable`. H4-008 passes the
compiler-owned immutable approval inventory into the accepted H4-007 workflow
runtime and removes its transitional `agentCanRequestApproval` traversal; the
workflow runtime must not walk definitions or derive requirements. If the row
is absent, runtime assembly fails closed as an invalid compiled graph before a
session is published. If the selected agent or a reachable subagent can request
approval through permissions or governance, start rejects
with `ValidationError{where:'invoke_options',issues:{reason:
'approval_capable_child_task_unsupported'}}`. This applies equally to
one-shot, continuable, awaited, and background tasks. Approval remains fully
supported through `context.agents.*.run(...)`, whose child interruption uses
the normal root protocol. The rejected start creates no task record, status,
or event.

Workflow agent-call limits resolve once from `agentCalls.maxCalls` and
`agentCalls.maxParallel`, then Harness defaults `maxWorkflowAgentCalls` and
`maxParallelWorkflowAgentCalls`, then constants `32` and `8`. Every configured
value is a positive safe integer. One budget state belongs to one logical
workflow invocation, resets for a later independent invocation, and is restored
unchanged for handler re-entry after interruption or durable resume. It counts
direct calls, one-shot initial turns, continuable initial turns, and every
accepted continuable `send`; `fanOut` itself adds no count. Equal replay or
coalescing consumes no additional count.

Admission order is exact: validate options and resolve replay first; reserve
one total call second; acquire parallel capacity third. Direct calls fail
immediately when the parallel ceiling is full or a queued task turn already
exists. Task initial/send turns enter one cancellation-aware FIFO and wait for
capacity. Total-capacity failure starts no dispatch or turn. Cancellation while
queued removes the waiter, but its accepted total reservation remains consumed.
A direct parallel failure rolls back its tentative total reservation. `fanOut`
never reserves total budget or acquires a workflow agent-call slot; it only
clamps worker concurrency to the effective parallel ceiling and preserves input
order. Every agent call or task turn inside a worker performs its own admission.
Limit failures use `WorkflowAgentCallBudgetError` with code
`WORKFLOW_AGENT_CALL_BUDGET_EXCEEDED`, category `validation`, retriable
`false`, fixed message `Workflow agent-call budget exceeded.`, and exact
metadata `{workflow_id,agent_id,reason,limit}`. Reason is `max_calls` or
`max_parallel`. No v3 delegation-policy allowlist, model override, or depth
error participates in this budget.

One `callId` namespace covers direct calls and child-task starts. Its identity
tuple is `(operation,target,canonical JSON wire input,normalized options)`,
where operation is `agent_run` or `child_task_start`; `signal` is never part of
identity. Direct options contain `idempotencyKey|null`. Child-task options
contain `mode`, `idempotencyKey|null`, `timeoutMs|null`, and
`context:'isolated'`. Equal tuples replay or coalesce to the same output or
handle. Reuse with a changed operation, target, input, options, or idempotency
key throws `WorkflowCallReplayConflictError` before budget or effects.

Workflow direct-agent replay uses one exact logical record:

```ts
type WorkflowAgentCallStoredErrorV1 =
  | Readonly<{
      code: 'WORKFLOW_CHILD_TARGET_FAILED'
      message: 'Workflow child target failed.'
      category: 'internal'
      retriable: false
      meta: Readonly<{
        reason: 'agent_call_failed'
        workflow_id: string
        call_id: string
        target_kind: 'agent'
        target_id: string
      }>
    }>
  | Readonly<{
      code: 'OPERATION_CANCELLED'
      message: 'Workflow agent call was cancelled.'
      category: 'cancelled'
      retriable: false
      meta: Readonly<{ scope: 'agent' }>
    }>

type WorkflowChildCallStoredOutcomeV1 =
  | Readonly<{ status: 'completed'; output: JsonValue }>
  | Readonly<{
      status: 'failed'
      error: Extract<
        WorkflowAgentCallStoredErrorV1,
        { readonly code: 'WORKFLOW_CHILD_TARGET_FAILED' }
      >
    }>
  | Readonly<{
      status: 'cancelled'
      error: Extract<
        WorkflowAgentCallStoredErrorV1,
        { readonly code: 'OPERATION_CANCELLED' }
      >
    }>

interface WorkflowChildCallCheckpointV1 {
  readonly schemaVersion: 1
  readonly kind: 'workflow_child_call'
  readonly callId: string
  readonly target: Readonly<{ kind: 'agent'; id: string }>
  readonly input: JsonValue
  readonly outcome: WorkflowChildCallStoredOutcomeV1
  readonly lineage: Readonly<{
    rootRunId: string
    workflowRunId: string
    workflowInvocationId: string
    childRunId: string
    childInvocationId: string
  }>
}
```

The persistent checkpoint key is exactly `workflow:call:<callId>`. Managed
workflow steps use `workflow:step:<stepId>`, so equal public ids never collide.
The child-call record is stored as the `RunCheckpoint.output`; the enclosing
checkpoint remains the single owner of run, session, lease, worker, attempt,
sequence, and commit-time fields. `RunCheckpoint.input` is exactly the
validated root workflow handler input; the child wire input exists only in
`WorkflowChildCallCheckpointV1.input`. Checkpoint metadata is exactly
`{checkpointKind:'workflow_child_call',schemaVersion:1}`. No new HarnessStorage
method or second checkpoint registry is introduced. The record's `input` is the caller's JSON wire value
before the receiving target's Standard Schema validation or transform.
Equality uses the canonical JSON encoder defined by this specification, so
object property order is irrelevant. This preserves the dispatcher contract:
only the receiving target validates and transforms target input, exactly once.

Each active workflow invocation also owns a map from `callId` to the complete
operation/target/input/options tuple above and one shared pending or completed
promise. Concurrent calls with the same id and equal tuple coalesce onto that
promise and dispatch once, including when that promise rejects. A different
tuple fails immediately and never opens a second dispatch. Conflict reason
precedence is `operation_mismatch`, `target_mismatch`, `input_mismatch`,
`idempotency_key_mismatch`, then `options_mismatch`; only the first difference
is reported. An ordinary non-interruptible ephemeral
invocation keeps this map only for that invocation: equal ids replay or
coalesce inside the invocation, but a later independent invocation starts a
new map. Durable invocations load and commit the namespaced `RunCheckpoint`
record above. A completed terminal returns its stored validated output. A
failed terminal rejects with the same canonical `WorkflowChildTargetError`, and
a cancelled terminal rejects with the same canonical `OperationCancelledError`;
both are committed before the handler observes the rejection. A handler may
therefore catch either error and continue, and later handler re-entry rejects
the equal call from the stored outcome without dispatching again. The stored
error is validated as the exact local canonical serialization before its fixed
class is reconstructed; transported remote class, category, and retriable data
are never trusted. Cancellation before call admission creates no call-table or
checkpoint entry. Cancellation after admission, whether transported as the
target terminal or observed locally while consuming it, uses the same
`cancelled` outcome; durable commit uses the non-aborted lifecycle signal and
finishes before the handler receives `OperationCancelledError`.
Approval-capable invocations already require durable storage;
H4-008 provisions the same H4-007 checkpoint access even when the root call did
not select `InvokeOptions.durable`, because interruption resume is the same
logical invocation. H4-008 preserves that access as part of root continuation
ownership and supplies the stored records when the workflow is re-entered.

Tuple mismatch throws this public error and never includes input, hashes, or
other content in its message or metadata:

```ts
class WorkflowCallReplayConflictError extends HarnessError {
  readonly code: 'WORKFLOW_CALL_REPLAY_CONFLICT'
  readonly category: 'validation'
  readonly retriable: false
  readonly message: 'Workflow call id conflicts with an existing logical child call.'
  readonly meta: Readonly<{
    reason:
      | 'operation_mismatch'
      | 'target_mismatch'
      | 'input_mismatch'
      | 'idempotency_key_mismatch'
      | 'options_mismatch'
    workflow_id: string
    call_id: string
    expected_operation: 'agent_run' | 'child_task_start'
    received_operation: 'agent_run' | 'child_task_start'
    expected_target_kind: 'agent'
    expected_target_id: string
    received_target_kind: 'agent'
    received_target_id: string
  }>
}
```

Malformed or unavailable persisted records remain storage/internal failures;
they are not mislabeled as caller replay conflicts.

H4-007 extracts H4-006's already implemented target-stream consumption from
`runtime/subagent-execution.ts` into one package-private strict consumer in
that same module:

```ts
interface ConsumedHarnessTarget<Output> {
  readonly outcome: ExecutionTerminalOutcome<Output, HarnessInterrupt>
  readonly lineage: Readonly<{
    parentRunId: string
    childRunId: string
    childInvocationId: string
  }>
}

function consumeHarnessTargetStream<Output>(options: Readonly<{
  stream: HarnessTargetDispatchStream<Output>
  signal: AbortSignal
  parentRunId: string
  childInvocationId: string
  relay(event: ExecutionEvent<Output>): Promise<void>
}>): Promise<ConsumedHarnessTarget<Output>>
```

It validates correlation and event shapes, requires exactly one terminal,
rejects events after terminal, relays every valid event in order including the
terminal exactly once, cleans up iterator and stream on failure or cancellation,
and returns the already target-validated terminal plus lineage without applying
a caller-specific error mapping. Subagents and workflows both use it. A second
terminal consumer or copied validation switch is forbidden. The model-facing
subagent binding retains H4-006's `ToolError` mapping. A direct workflow call
returns a completed output, maps `failed` to `WorkflowChildTargetError` reason
`agent_call_failed`, maps `cancelled` to `OperationCancelledError` with fixed
message `Workflow agent call was cancelled.` and scope `agent`, and maps
`interrupted` to the existing package-private
`HarnessChildTargetInterruption` with that lineage. H4-008 alone
persists and resumes the root interruption tree. Child-task starts can never
reach this interrupted branch because approval-capable task targets are
rejected before dispatch. A `failed` envelope that claims a remote timeout is
still the target-failure wrapper; its code never selects a local error class.

`defineWorkflow` has required Standard JSON Schema `input` and `output` plus a
required `handler`; optional
`description`, exact typed `agents`, exact typed `models`, exact
`agentCalls: WorkflowAgentCallLimits`, exact literal
`childTaskSandboxGroups`, existing sandbox
policy, positive integer `maxDepth`, literal `workspace: true`, and literal
`durable: true`. Its model
entries declare an alias and nonempty capability list. Workspace and durable
fields contribute the same requirements as agent fields. Harness options
contain only `name` and content-free execution defaults; they never contain
live adapters.

The v4 execution defaults are one closed definition-time contract:

```ts
interface HarnessExecutionDefaults {
  readonly maxSteps?: number
  readonly maxToolCalls?: number
  readonly maxSubagentCalls?: number
  readonly maxParallelSubagents?: number
  readonly maxWorkflowAgentCalls?: number
  readonly maxParallelWorkflowAgentCalls?: number
  readonly maxDepth?: number
  readonly runTimeoutMs?: number
  readonly modelTimeoutMs?: number
  readonly toolTimeoutMs?: number
  readonly skillTimeoutMs?: number
  readonly decisionTimeoutMs?: number
  readonly maxParallelToolCalls?: number
  readonly historyWindow?: number
  readonly contextProjection?: ContextProjectionPolicy
  readonly historyRetention?: SessionHistoryRetentionPolicy
}

interface HarnessOptions<Name extends string = string> {
  readonly name: Name
  readonly revision?: string
  readonly defaults?: HarnessExecutionDefaults
}

interface ResolvedHarnessExecutionDefaults {
  readonly maxSteps: number
  readonly maxToolCalls: number
  readonly maxSubagentCalls: number
  readonly maxParallelSubagents: number
  readonly maxWorkflowAgentCalls: number
  readonly maxParallelWorkflowAgentCalls: number
  readonly maxDepth: number
  readonly runTimeoutMs: number
  readonly modelTimeoutMs: number
  readonly toolTimeoutMs: number
  readonly skillTimeoutMs: number
  readonly decisionTimeoutMs: number
  readonly maxParallelToolCalls: number
  readonly historyWindow?: number
  readonly contextProjection?: ContextProjectionPolicy
  readonly historyRetention?: SessionHistoryRetentionPolicy
}
```

The resolved constants are `maxSteps:16`, `maxToolCalls:32`,
`maxSubagentCalls:32`, `maxParallelSubagents:8`,
`maxWorkflowAgentCalls:32`, `maxParallelWorkflowAgentCalls:8`, `maxDepth:1`,
`runTimeoutMs:600_000`, `modelTimeoutMs:300_000`,
`toolTimeoutMs:120_000`, `skillTimeoutMs:60_000`,
`decisionTimeoutMs:10_000`, and `maxParallelToolCalls:8`.
`historyWindow`, `contextProjection`, and `historyRetention` are absent by
default. `defineHarness` rejects unknown default keys and produces one deeply
frozen resolved snapshot. Every integer must be safe. `runTimeoutMs` and
`historyWindow` accept zero with their existing meanings; every other numeric
default is positive. Context projection and retention use their existing
closed validators.

`revision` is an application-controlled deployment revision using the bounded
configuration-reference rule. It is required exactly when the compiled
`RuntimeRequirements.storage.durable` value is `true`. Definitions that enable
approvals, external waits, durable targets, host-aware tools, or another
resumable interrupt must therefore contribute that durable-storage requirement
during graph compilation. Every host-aware tool receives checkpoint and nested
target helpers, so its presence conservatively makes the graph durable without
another authoring flag.
A graph whose durable-storage requirement is `false` may omit it. The compiler
validates this invariant after every immutable `add*` and `use` operation, and
every returned Harness definition preserves the supplied revision. A deployment
changes the revision whenever handler,
Guardrail, policy, schema, prompt, or orchestration behavior changes in a way
that must invalidate suspended work. Harness never hashes JavaScript function
source as a substitute.

An agent's `loop` field overrides the five matching loop defaults. Invocation
`timeoutMs` overrides the root timeout, including zero disabling it, while an
inherited parent deadline still bounds every nested run. Invocation
`historyWindow` overrides the Harness history window. Context projection
precedence is invocation, then selected model alias, then Harness. Model-alias
generation defaults, retry, provider options, and credential scope remain
model-specific and are not copied into this object. History retention remains
Harness-wide. H4-004 Skill/MCP initialization, H4-005 execution, and H4-008
session assembly consume this same resolved snapshot and do not derive another
set of fallback values.

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

The compiler also owns the sole recursive approval-reachability projection:

```ts
interface CompiledTargetApprovalInventory {
  readonly reachable: boolean
  readonly agentIds: readonly string[]
}

interface CompiledApprovalInventory {
  readonly agents: Readonly<
    Record<string, CompiledTargetApprovalInventory>
  >
  readonly workflows: Readonly<
    Record<string, CompiledTargetApprovalInventory>
  >
}

interface CompiledDefinitionGraph {
  // existing immutable per-kind definition maps and RuntimeRequirements
  readonly approval: CompiledApprovalInventory
}
```

For an agent root, `agentIds` is the deduplicated bytewise-sorted set of that
agent and recursively reachable subagents whose own permission declaration or
compiled governance effect declaration contains `require_approval`. Guardrail
requirements, including `requirements.durable:true`, never add approval
reachability because Guardrails cannot request tool approval. For a workflow root, it is the
union from every declared agent edge and each agent's recursive subagent
closure. `reachable` is exactly `agentIds.length > 0`. The maps contain every
compiled agent and workflow id, use deterministic key order, and every map,
inventory, and array is frozen. Cycles have already failed before this pass.
The compiler calculates this once while it owns the validated graph. Runtime
requirement derivation consumes this projection for the permission/governance
approval contribution to `storage.durable` and separately adds Guardrail
`requirements.durable:true`; H4-007
approval-capable child-task checks and H4-008 root lease selection consume the
same entries. None traverses definitions or reconstructs approval reachability.
The projection remains package-private and is excluded from catalog,
inspection, digest, export, and public type surfaces.

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
tools, Skills, Guardrails, workflow model declarations, and memory. A selected
tool, subagent, or Skill adds `tool_use`; a text agent adds `text` and
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
  RequiredSandboxGroupId extends string = string,
  SandboxRequired extends boolean = boolean,
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
    requiredGroups: readonly RequiredSandboxGroupId[]
    required: SandboxRequired
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
permissions, governance effect declarations, Guardrail requirement flags, and media-generation model
capabilities is preserved through the definition types. The derived requirement
type therefore exposes literal `true` or `false` for `storage.durable`,
`workspace`, and `artifacts`; it never widens these fields to `boolean` for a
concrete graph.

`sandbox.requiredGroups` is the exact literal union of named groups referenced
by agent/workflow sandbox policies or declared for workflow child-task
overrides. It is a requirement, not a configured or authorized group registry.
`defineAgent` and `defineWorkflow` preserve their sandbox policy as a const
generic, and `defineWorkflow` preserves `childTaskSandboxGroups` as a const
tuple, so this union never widens to `string` in a concrete graph.
The runtime host must explicitly include every required group in its binding.
`sandbox.required` is literal `true` exactly when sandbox capabilities are
nonempty, Skill runtimes are nonempty, `workspace` is true, an agent/workflow
sandbox policy is present, or `sandbox.requiredGroups` is nonempty; otherwise
it is literal `false`. These fields are compiler-owned requirements, so catalog
composition preserves group names without a broad string registry or a second
definition walk.

Requirement derivation follows this order:

- agent output mode and selected tools contribute model capabilities;
- agent `memory` contributes memory capabilities and embedding/summary aliases;
- built-in tools, portable-tool `requires`, Guardrails, and executable runtime
  needs contribute sandbox capabilities; Skills contribute logical runtimes,
  and each runtime-bearing Skill additionally contributes `sandbox.fs` and
  `sandbox.readonly_mount`;
- agent and workflow sandbox policies contribute their literal group id, when
  present, and make the sandbox required even when they add no capability;
  a workflow's child-task sandbox-group declaration contributes each literal
  group it permits its handler to select;
- agent/workflow `durable: true`, permission/governance approvals, Guardrail
  `requirements.durable:true`, durable child tasks, and any host-aware tool
  require durable storage;
- definition `workspace: true` requires a workspace binding;
- workflow `models` declares embeddings, reranking, image, speech, and video;
- image, speech, and video generation requires an artifact store; and
- `AgentAdmission` and provider `ModelAdmission` are optional deployment
  controls and are never inferred as required.

Canonical runtime-requirement serialization includes the sorted host-tool ids
and the literal marker `host-nested-target-checkpoint.v1` whenever that list is
nonempty. The marker records the fixed durability policy; the owner token,
opaque invocation, handler context, dispatcher, logger, telemetry, and concrete
runtime bindings never enter a graph or requirement digest. Every target in a
host-aware graph uses lease-backed execution because a host tool can occur
through any reachable agent or workflow path.

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

type HarnessSandboxBindingOptions<
  Requirements extends RuntimeRequirements,
  ConfiguredGroups extends readonly string[],
> = Exclude<
  Requirements['sandbox']['requiredGroups'][number],
  ConfiguredGroups[number]
> extends never
  ? Readonly<
      Omit<
        SandboxBindingOptions<NoInfer<ConfiguredGroups[number]>>,
        'groups'
      > & (
        [Requirements['sandbox']['requiredGroups'][number]] extends [never]
          ? { groups?: ConfiguredGroups }
          : { groups: ConfiguredGroups }
      )
    >
  : never

type SandboxBindingOptionsField<
  Requirements extends RuntimeRequirements,
  ConfiguredGroups extends readonly string[],
> = [Requirements['sandbox']['requiredGroups'][number]] extends [never]
  ? Readonly<{
      sandboxBinding?: HarnessSandboxBindingOptions<
        Requirements,
        ConfiguredGroups
      >
    }>
  : Readonly<{
      sandboxBinding: HarnessSandboxBindingOptions<
        Requirements,
        ConfiguredGroups
      >
    }>

type SandboxFields<
  Requirements extends RuntimeRequirements,
  ConfiguredGroups extends readonly string[],
> = Requirements['sandbox']['required'] extends true
    ? Readonly<{ sandbox: SandboxBinding<Requirements> }>
      & SandboxBindingOptionsField<Requirements, ConfiguredGroups>
    : Readonly<{ sandbox?: never; sandboxBinding?: never }>

type HarnessRuntimeBindingFields<
  Requirements extends RuntimeRequirements,
  const ConfiguredGroups extends readonly string[] = readonly [],
> = ModelFields<Requirements>
  & RequiredField<
    HasMembers<Requirements['mcpServers']>,
    'mcp',
    Readonly<{
      [ServerId in Requirements['mcpServers'][number]]: McpBinding
    }>
  >
  & RequiredField<Requirements['storage']['durable'], 'storage', HarnessStorage>
  & RequiredField<
    Or<
      HasMembers<Requirements['memory']['capabilities']>,
      HasMembers<Requirements['memory']['modelAliases']>
    >,
    'memory',
    MemoryEngine
  >
  & SandboxFields<Requirements, ConfiguredGroups>
  & RequiredField<Requirements['workspace'], 'workspace', DurableWorkspace>
  & RequiredField<Requirements['artifacts'], 'artifacts', ArtifactStore>
  & Readonly<{
    agentAdmission?: AgentAdmission
    admission?: ModelAdmission
  }>

type HarnessInstanceConfig<
  Requirements extends RuntimeRequirements,
  const ConfiguredGroups extends readonly string[] = readonly [],
> = [Requirements['hostTools'][number]] extends [never]
  ? Readonly<HarnessRuntimeBindingFields<Requirements, ConfiguredGroups> & {
      logger?: Logger
      telemetry?: TelemetryOptions
    }>
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
- `sandbox` is required exactly when `sandbox.required` is literal `true`; in
  that case strict `sandboxBinding` options are optional, while both fields are
  forbidden when it is literal `false`;
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
  sandboxBinding: {
    groups: ['case-review', 'support'],
    defaultPolicy: { group: 'support' },
    authorizeOwner: authorizeBankingOwner,
  },
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

`sandboxBinding` reuses spec 36's closed `SandboxBindingOptions` contract.
`getInstance` infers `groups` as one composition-owned const tuple. The field is
required when the graph has any `RuntimeRequirements.sandbox.requiredGroups`,
and that tuple must contain all of them; it may also contain runtime-only
groups. A graph reference never configures or authorizes its own group.
`defaultPolicy` uses `NoInfer<ConfiguredGroups[number]>`, so only `groups`
supplies the group vocabulary and a typo cannot become another inference
source. Runtime validation rejects malformed or duplicate configured groups,
a missing required group, and a default group outside the configured set. It
copies and freezes `groups` and `defaultPolicy` while preserving the trusted
`authorizeOwner` callback identity. The exact configured group set and default
policy participate in partition selection and the durable partition-policy
digest.

An explicit borrowed `sandboxOwner` is available only when
`sandbox.required` is true. It is authorized at session attachment and again
before every top-level invocation, child launch, and resumed execution. Tenant
and principal scope checks run before the callback as required by spec 36. A
missing callback, denial, or throw fails before admission or effects. The
callback never enters an agent, workflow, tool, or general runtime context.

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
   `sandbox` with its optional `sandboxBinding`, `workspace`, `artifacts`
   order;
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
closes only the Harness-created defaults and MCP bundles listed in the exact
ownership table below; every caller-supplied provider or adapter is borrowed.

H4-004 owns immutable Skill loading, MCP server initialization, built-in tool
definitions, and the first package-private executable bindings for portable,
built-in, `read_skill`, and MCP tools. H4-005 finalizes every such binding into
the exact shared identity-and-digest shape below while constructing the common
pipeline; later binding kinds must implement that same shape. A binding exposes its model-facing id,
description, input/output schemas, implementation kind, hidden original
definition identity, contract digest, and an `invokeValidated` operation. It
performs only the validated implementation or transport call and emits no
portable tool lifecycle event. The one package-private shape is:

```ts
type AgentBindingKind =
  | 'portable'
  | 'built-in'
  | 'read-skill'
  | 'mcp'
  | 'subagent'
  | 'host'

interface AgentToolInvocationContext {
  readonly harnessName: string
  readonly sessionId: string
  readonly runId: string
  readonly rootRunId: string
  readonly parentRunId?: string
  readonly parentInvocationId?: string
  readonly invocationId: string
  readonly depth: number
  readonly remainingDepth: number
  readonly agentId: string
  readonly workflowId?: string
  readonly step: number
  readonly toolId: string
  readonly callId: string
  readonly idempotencyKey?: string
  readonly identity?: HarnessIdentity
  readonly trace?: HarnessTraceContext
  readonly deadline?: number
  readonly signal: AbortSignal
  readonly metadata: Readonly<Record<string, JsonValue>>
  readonly logger: Logger
  readonly metrics: Metrics
  readonly telemetry: TelemetryShim
  readonly memory: MemoryFacade
  readonly sandbox: SandboxSessionBase
  readonly targetDispatcher: HarnessTargetDispatcher
  relayChildEvent(event: ExecutionEvent): Promise<void>
  readonly checkpointStep: HarnessCheckpointStep
}

interface AgentExecutableBinding<
  Input extends ModelSchema = ModelSchema,
  Output extends Schema = Schema,
> {
  readonly id: string
  readonly description: string
  readonly input: Input
  readonly output: Output
  readonly implementationKind: AgentBindingKind
  readonly definitionIdentity: DefinitionIdentity
  readonly contractDigest: string
  readonly outputValidation: 'required' | 'already-validated-target'
  invokeValidated(
    context: AgentToolInvocationContext,
    input: Infer<Input> & JsonValue,
    wireInput: InferIn<Input> & JsonValue,
  ): Promise<unknown>
}

declare const harnessChildTargetInterruptionBrand: unique symbol

interface HarnessChildTargetInterruption {
  readonly [harnessChildTargetInterruptionBrand]: true
  readonly childInvocationId: string
  readonly outcome: Extract<
    RunOutcome<never>,
    { readonly status: 'interrupted' }
  >
}

declare function createHarnessChildTargetInterruption(
  childInvocationId: string,
  outcome: Extract<RunOutcome<never>, { readonly status: 'interrupted' }>,
): HarnessChildTargetInterruption

declare function isHarnessChildTargetInterruption(
  value: unknown,
): value is HarnessChildTargetInterruption
```

`DefinitionIdentity` is the existing package-private identity record; the
binding never exposes the original definition object as a service locator.
`contractDigest` is `sha256:` plus lowercase SHA-256 over the UTF-8 canonical
JSON encoding of this exact tuple:

```ts
type BindingDigestPreimageV1 = readonly [
  'harness.binding.v1',
  modelFacingId: string,
  implementationKind: AgentBindingKind,
  definition: readonly [
    kind: 'tool' | 'built-in-tool' | 'host-tool' | 'mcp-tool' | 'agent',
    id: string,
  ],
  mcpOwner: readonly [kind: 'mcp-server', id: string] | null,
  remoteMcpName: string | null,
  normalizedProviderInputJsonSchema: JsonValue,
]

interface AgentExecutableBindingSource<
  Input extends ModelSchema = ModelSchema,
  Output extends Schema = Schema,
> extends Omit<AgentExecutableBinding<Input, Output>, 'contractDigest'> {
  readonly digestDefinition: BindingDigestPreimageV1[3]
  readonly mcpOwner: BindingDigestPreimageV1[4]
  readonly remoteMcpName: BindingDigestPreimageV1[5]
}

declare function createAgentExecutableBinding<
  Input extends ModelSchema,
  Output extends Schema,
>(
  source: AgentExecutableBindingSource<Input, Output>,
): AgentExecutableBinding<Input, Output>
```

Non-MCP bindings use `null` for both MCP positions. No tuple position is omitted
and `undefined` is rejected before hashing. Arbitrary Standard Schema output
validators have no portable JSON representation and are deliberately excluded;
the application revision protects executable and non-serializable behavior.
The canonical JSON encoder recursively sorts object keys by Unicode code point,
preserves array order, rejects `undefined`, non-finite numbers, bigint, symbols,
functions, and non-JSON prototypes, and uses ordinary JSON primitive encoding
before UTF-8 hashing. The digest contains no function source or inspected
runtime content. H4-004 creates portable,
built-in, `read-skill`, and MCP bindings. The shape reserves `subagent` for
H4-006 and `host` for H4-009. An unbound host seam is not executable.

The implementation-kind-to-identity mapping is exact:

| `implementationKind` | `definitionIdentity` | digest `definition` | MCP fields |
| --- | --- | --- | --- |
| `portable` | original portable tool identity | `['tool', tool.id]` | both `null` |
| `built-in` | original built-in tool identity | `['built-in-tool', tool.id]` | both `null` |
| `read-skill` | owning agent definition identity | `['agent', agent.id]` | both `null` |
| `mcp` | original MCP tool identity | `['mcp-tool', tool.id]` | owner tuple and remote name required |
| `subagent` | referenced child agent identity | `['agent', child.id]` | both `null` |
| `host` | original host-tool identity | `['host-tool', tool.id]` | both `null` |

The generated `read_skill` binding therefore remains per-agent and has no
synthetic definition or catalog entry. Its binding `id` stays the reserved
`read_skill` model-facing name, while its identity token and digest definition
come from the owning agent. Only an MCP binding may use non-null MCP positions;
every other combination fails internal compilation.
`createAgentExecutableBinding` is the sole package-private binding finalizer.
It validates the implementation-kind mapping above, computes the canonical
digest, removes the three digest-source-only fields, and deeply freezes the
returned binding. It also requires
`outputValidation:'already-validated-target'` exactly for `subagent` and
`outputValidation:'required'` for every other implementation kind. H4-004
binding factories, H4-006 subagent bindings, and H4-009 host bindings all use
this helper; none reimplement digest or freeze rules.
`AgentToolInvocationContext` is package-private. Binding factories project its
memory and sandbox handles to a portable tool's declared requirement type. A
subagent binding uses `targetDispatcher` and relays every child event through
`relayChildEvent`, which preserves the child correlation already added by
H4-008. Its dispatch request takes `depth`, `remainingDepth`, and `trace` only
from this runtime-authored context. When a child stream terminates with an
interrupted outcome, the subagent binding throws the frozen package-private
`HarnessChildTargetInterruption` created by the factory above. The common tool
pipeline recognizes that value before generic error projection, emits neither
`tool.finished(error)` nor `ToolError`, and rethrows the same control value for
the root runtime to convert into its interrupted outcome. The control symbol,
factory, and type guard are owned by package-private `runtime/steps.ts`. No
application handler receives this broad internal shape or either control helper
directly.
H4-009 creates a run-scoped immutable overlay of host bindings whose closures
capture that run's fresh authenticated `HostInvocation`; the value never enters
this context, an instance registry, a checkpoint, or persistence.

H4-005 owns model exposure and the single common tool-execution pipeline. It
resolves a model-returned local name through the current agent's immutable
binding map, applies input/output transforms, validates each boundary exactly
once, evaluates permission and governance, handles approval, invokes the
prepared binding only after approval, and emits the common telemetry, events,
timeout, and cancellation outcome. H4-006 supplies subagent bindings through
the reserved seam and uses `HarnessTargetDispatcher`; H4-009 supplies
host-aware bindings through the other reserved seam. Neither duplicates input
validation, decisions, approval, output validation, lifecycle events, timeout,
or telemetry. No H4-004 initializer or binding is a public service locator or
direct invocation API. H4-008 calls the Skill and MCP initializers, owns
cross-initializer rollback and the returned private immutable bundles, and
closes instance-owned resources.

The pipeline preserves two input values after `beforeTool`: `wireInput` is the
post-transform JSON value typed as `InferIn<Input>`, while `input` is the one
schema-parsed `Infer<Input>` value used by permission, governance, approval,
and ordinary handlers. It passes both to `invokeValidated`. Portable,
built-in, `read_skill`, MCP, and host bindings use `input`; a subagent binding
dispatches `wireInput`, allowing the receiving target to validate that wire
value once without treating an already transformed output as fresh input.
Because schemas are pure and deterministic, the parent policy parse and the
receiving target parse produce the same validated value from the same wire
value.

For `outputValidation:'required'`, the pipeline validates the returned value
with the binding output schema. For
`outputValidation:'already-validated-target'`, the dispatcher has already
validated the child target output; the pipeline asserts only that it is still
a `JsonValue` and does not run the output schema or its transform again. Both
branches retain the same common output event, telemetry, checkpoint, timeout,
and error lifecycle.

To keep every intermediate ticket buildable without creating two public
executors, H4-005 adds the v4 loop and tool pipeline as package-private modules
beside the still-used v3 session runner. No v4 definition or instance path may
call that old runner. H4-008 assembles every v4
`HarnessDefinition.getInstance` exclusively through
`runtime/standalone-instance.ts` and the accepted v4 loop, tool pipeline,
dispatcher, and workflow runtime. The staged v3 session runner and its baseline
tests may remain physically present but isolated until H4-011, which removes
them before any v4 release. H4-008 adds no compatibility alias or fallback, and
no v4 path exposes or invokes the old code. H4-011 verifies that none remains.

H4-005 also owns the contract-only declarations of `HarnessTargetDispatcher`
and `HarnessCheckpointStep`, because the common binding context must compile
before later execution tickets. Those declarations contain no local dispatch
or durable-step implementation. H4-006 supplies the dispatcher implementation;
H4-007 supplies checkpoint execution and replay. Structural copies in the tool
package are forbidden.

The agent loop allocates exactly one private `streamId` for each provider
`textStream` or `objectStream` operation and supplies it through the
package-private model-call context. Every provisional or guarded output event
from that provider turn uses the same id. H4-008's session-context model wrapper
must preserve a supplied id and emit it unchanged on that turn's
`model.completed`; it may allocate an id only for a direct streaming model call
whose caller supplied none. The agent loop never creates a second id for the
same provider turn.

The H4-005 event sink uses a positive type allowlist rather than a broad
exclusion from the full protocol:

```ts
type AgentPipelineEventType =
  | 'agent.started'
  | 'agent.finished'
  | 'model.message'
  | 'output.text.delta'
  | 'output.object.snapshot'
  | 'tool.input.available'
  | 'tool.started'
  | 'tool.finished'
  | 'policy.exposure'
  | 'policy.evaluated'
  | 'approval.requested'
  | 'approval.responded'

type AgentPipelineEvent = {
  [Type in AgentPipelineEventType]: Omit<
    Extract<ExecutionEvent, { readonly type: Type }>,
    keyof ExecutionEventCorrelation
  >
}[AgentPipelineEventType]

interface AgentEventSink {
  emit(event: AgentPipelineEvent): Promise<void>
}
```

H4-008 adds the executing `runId`, optional parent correlation, event sequence,
persistence, and bounded delivery. It is the sole owner of `run.started`,
`run.finished`, `model.completed`, external-wait, fanout, child-task, media,
embedding, reranking, and overflow events. The session model wrapper calls the
agent loop with provider run-event emission disabled and emits exactly one
`model.completed` after each valid non-stream response or valid stream finish.
H4-005 never emits it. A logical agent emits one `agent.started`; approval
suspension emits no `agent.finished`; resume emits no second start; eventual
completion, failure, or cancellation emits one finish. H4-008 persists that
lifecycle state and enforces the rule across restarts. Every emitted
`tool.started` has exactly one `tool.finished`; a denied, rejected, or
recoverable preflight result may emit `tool.finished` without `tool.started`
because no side effect began.

H4-008 also replaces the stale object-only
`AgentAfterModelInterceptorContext.response` declaration with the
`AgentModelResponse` union defined in the approval cursor contract and updates
its TSDoc: the hook runs after the corresponding sanitized `model.completed`
event and before output validation or tool dispatch. The request remains
`AgentModelRequest`, whose `schema` field becomes optional and is present
exactly for object/object-stream operations. It is exposed as that contract's
recursively frozen effective projection. Live and resumed turns share the same
request, response, and continuation reattachment helpers. H4-008 owns this
breaking public type and TSDoc correction in `defineHarness.ts` plus both-mode
live/resume parity tests in `agent-loop.test.ts`.

The provider-neutral host SPI is public and stable. Its generic spelling may
use internal helper types, but it exposes this information without requiring a
host to inspect compiler state:

```ts
interface HarnessDefinition<
  Catalog extends HarnessCatalogView<any, any, any, any, any, any>,
> {
  readonly kind: 'harness'
  readonly name: string
  readonly revision?: string
  readonly defaults: Readonly<ResolvedHarnessExecutionDefaults>
  readonly catalog: Catalog
  readonly contracts: Catalog['contracts']
  readonly requirements: Catalog['requirements']
  readonly $infer: HarnessInfer<
    Catalog['contracts'],
    Catalog['requirements']
  >
  inspect(): HarnessInspection<Catalog['requirements']>
  getInstance<const ConfiguredGroups extends readonly string[] = readonly []>(
    config: HarnessInstanceConfig<
      Catalog['requirements'],
      ConfiguredGroups
    >,
  ): Promise<HarnessInstance<
    Catalog['contracts'],
    Catalog['requirements']
  >>
}
```

The standalone public runtime surface is exact. It exposes only definition-keyed
target invokers and session facilities; model handles, compiled registries,
definition identities, and lifecycle internals are not public instance fields.

```ts
interface DurableInvokeOptions {
  readonly runId: string
  readonly workerId?: string
  readonly stepId?: string
  readonly attempt?: number
  readonly workspacePolicy?: Partial<DurableWorkspacePolicy>
}

interface InvokeOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly historyWindow?: number
  readonly idempotencyKey?: string
  readonly contextProjection?: ContextProjectionPolicy
  readonly traceparent?: string
  readonly tracestate?: string
  readonly metadata?: Readonly<Record<string, JsonValue>>
  readonly resume?: ToolApprovalResume
  readonly durable?: DurableInvokeOptions
}

interface HarnessTargetInvoker<Target extends AnyHarnessTargetContract> {
  run(
    input: HarnessTargetInput<Target>,
    options?: InvokeOptions,
  ): Promise<RunOutcome<HarnessTargetOutput<Target>>>
  stream(
    input: HarnessTargetInput<Target>,
    options?: InvokeOptions,
  ): AsyncIterable<ExecutionEvent<HarnessTargetOutput<Target>>>
}

interface SessionChildTasks {
  get(id: string): Promise<ChildTaskHandle<JsonValue> | undefined>
  list(
    options?: Readonly<{ limit?: number; before?: string }>,
  ): Promise<readonly ChildTaskStatus[]>
}

interface HarnessSession<Contracts extends HarnessContracts<any, any>> {
  readonly id: string
  readonly agents: Readonly<{
    [Id in keyof Contracts['agents']]:
      HarnessTargetInvoker<Contracts['agents'][Id]>
  }>
  readonly workflows: Readonly<{
    [Id in keyof Contracts['workflows']]:
      HarnessTargetInvoker<Contracts['workflows'][Id]>
  }>
  readonly childTasks: SessionChildTasks
  readonly memory: SessionMemory
  readonly history: ConversationHistory
  getRunSummary(runId: string): Promise<RunSummary | undefined>
  clearHistory(): Promise<void>
  replaceHistory(
    messages: readonly Omit<Message, 'id' | 'timestamp'>[],
  ): Promise<void>
  release(): Promise<void>
  destroy(): Promise<void>
}

type SessionOptionsFor<Requirements extends RuntimeRequirements> =
  Requirements['sandbox']['required'] extends true
    ? SessionOptions
    : Readonly<{
        identity?: HarnessIdentity
        sandboxOwner?: never
      }>

interface HarnessInstance<
  Contracts extends HarnessContracts<any, any>,
  Requirements extends RuntimeRequirements,
> {
  getSession(
    id: string,
    options?: SessionOptionsFor<Requirements>,
  ): Promise<HarnessSession<Contracts>>
  close(): Promise<void>
}
```

`SessionOptionsFor` projects the existing closed sandbox-ownership contract
from spec 36 `CTR-SOWN-POLICY`. Identity remains available for every session.
An explicit `sandboxOwner` is present only when `sandbox.required` is literal
`true`; erased-type use against a sandbox-free graph is rejected before any
session write. H4-008 reuses the existing schemas and does not create another
runtime representation.

`SessionChildTasks` is owner-only. Its `get(id)` strictly validates the candidate
`child_task` `RunRecord` and returns `undefined` for an absent or foreign-session
record. It returns the existing frozen handle for a resident task and the frozen
reconstructed handle for a terminal task. For a valid non-resident running
record it returns a frozen recovery handle whose `status()` returns the validated
frozen content-free running snapshot. `result()` and `cancel()` each reject a
locally constructed `ChildTaskStateError` with exact metadata
`{reason:'recovery_required',task_id,workflow_id,agent_id}` and no transported
cause or stored message. The recovery handle grants no task admission,
dispatch, cancellation, event, or mutation authority.

`ChildTaskHandle<JsonValue>` and `ChildTaskStatus` in this interface are the
canonical child-task types defined in section 7 and implemented in
`definitions/types.ts`; the session surface does not declare or use another
handle, status, or descriptor representation.

`InvokeOptions` has exactly the keys above. In particular it has no
`hostContext`, target selector, model override, tool list, registry, provider,
or runtime adapter. `run` resolves only a `completed` or `interrupted`
`RunOutcome`; failed and cancelled execution rejects with its canonical local
error. `stream` yields the same logical execution as ordered events and always
ends with one `run.finished`, whose outcome may additionally be `failed` or
`cancelled`. Breaking iteration does not cancel execution; only the invocation
signal or runtime lifecycle does. Input is accepted in its schema input type,
validated exactly once by the receiving target, and output uses its schema
output type. Unknown target properties do not type-check and are not available
through a string lookup.

The `agents` and `workflows` maps and every invoker are frozen. Each invoker
closes over one hidden compiled target identity and the instance-private local
dispatcher. Tool, Skill, MCP, model, agent, workflow, binding, and continuation
registries are separate private immutable maps keyed by their owning typed
identity. They are never merged into a public registry, placed on a context, or
looked up through an unchecked string. Runtime assembly consumes the canonical
compiled graph, `RuntimeRequirements`, H4-003 validated binding snapshot, and
the one frozen resolved-defaults object; it never derives requirements or
definition closure again.

`close()` is the sole standalone shutdown method. The first call atomically
stops admission of new sessions and invocations, cancels live root trees and
child tasks, waits for their settlement and session attachment release, then
closes owned resources in reverse creation order. Concurrent calls return the
same promise and every cleanup is attempted once. Cleanup failures are
normalized to content-free Harness errors and thrown in one `AggregateError`
with fixed message `Harness close failed.` after all cleanup attempts. Calls
after close fail with `StateError{op:'getSession',reason:'instance_closed'}` or
the corresponding invocation operation; there is no reopen operation.

Ownership is fixed for v4:

| Runtime value | Ownership |
| --- | --- |
| caller-supplied model provider, storage, MemoryEngine, graph sandbox, workspace, artifact store | borrowed; never closed by Harness |
| caller-supplied agent/model admission, logger, telemetry, hosted dispatcher/context dependencies and MCP stdio sandbox adapter | borrowed; never closed by Harness |
| in-memory storage, spec 33 `inMemoryMemoryEngine()` or sandbox default created by Harness | owned and closed once when it exposes `close` |
| one initialized MCP server bundle, including its HTTP client or stdio process and synthetic session-scoped sandbox session | owned and closed once by the bundle |

Object identity, rather than alias count, deduplicates cleanup. Startup is
transactional: an initializer failure closes only resources already created by
that attempt in reverse order, leaves borrowed values untouched, and publishes
no partially constructed instance. Adapter objects are never frozen or
mutated.

If startup rollback itself succeeds, the initializer's canonical Harness error
is rethrown with its original identity; an unknown initializer throw is first
normalized to one content-free `InternalError`. If any rollback cleanup fails,
all remaining cleanup is still attempted and startup rejects one
`AggregateError` with fixed message
`Harness initialization failed and rollback cleanup failed.` Its `errors`
array is ordered as the normalized primary initializer error followed by each
normalized cleanup error in reverse resource-creation order, and its `cause`
is that same primary error. No raw adapter error message, path, command,
credential, input, output, prompt, or provider payload crosses this boundary.
The same object-identity deduplication and exactly-once cleanup rule used by
`close()` applies during rollback.

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
type HostOwnerToken<HostContext = unknown> = Readonly<{
  [hostOwnerBrand]: (context: HostContext) => HostContext
}>

declare function createHostOwnerToken<HostContext>():
  HostOwnerToken<HostContext>

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
  hostToolInvocationId: string
  parentRunId?: string
  depth: number
  remainingDepth: number
  deadline?: number
  signal: AbortSignal
  nestedTargets: HarnessNestedTargetInvoker
  checkpointStep: HarnessCheckpointStep
}>

interface HarnessHostBindings<HostInvocation, HostContext> {
  readonly hostOwner: HostOwnerToken<HostContext>
  readonly targetDispatcher: HarnessTargetDispatcher
  readonly projectIdentity:
    (hostInvocation: HostInvocation) => HarnessIdentity | undefined
  readonly projectTraceContext:
    (hostInvocation: HostInvocation) => HarnessTraceContext | undefined
  readonly createHostContext:
    (request: HarnessHostContextRequest<HostInvocation>) =>
      HostContext | Promise<HostContext>
  readonly logger: Logger
  readonly telemetry: TelemetryShim
}

type HostedTargetOf<Contracts extends HarnessContracts<any, any>> =
  | Contracts['agents'][keyof Contracts['agents']]
  | Contracts['workflows'][keyof Contracts['workflows']]

type HostedHarnessInstanceConfig<
  Requirements extends RuntimeRequirements,
  const ConfiguredGroups extends readonly string[] = readonly [],
> = Readonly<HarnessRuntimeBindingFields<Requirements, ConfiguredGroups> & {
  logger?: never
  telemetry?: never
}>

type HostedInvokeOptions = Readonly<
  Omit<InvokeOptions, 'traceparent' | 'tracestate'> & {
    sessionId: string
    traceparent?: never
    tracestate?: never
  }
>

type HostedTargetRequest<
  Target extends AnyHarnessTargetContract,
  HostInvocation,
> = Readonly<{
  target: Target
  input: HarnessValidatedTargetInput<Target>
  invokeOptions: HostedInvokeOptions
  hostInvocation: HostInvocation
}>

interface HostedHarnessInstance<
  Contracts extends HarnessContracts<any, any>,
  HostInvocation,
> {
  runHosted<Target extends HostedTargetOf<Contracts>>(
    request: HostedTargetRequest<Target, HostInvocation>,
  ): Promise<RunOutcome<HarnessTargetOutput<Target>>>
  streamHosted<Target extends HostedTargetOf<Contracts>>(
    request: HostedTargetRequest<Target, HostInvocation>,
  ): Promise<HarnessTargetDispatchStream<HarnessTargetOutput<Target>>>
  close(): Promise<void>
}

declare function instantiateHostedHarness<
  Catalog extends HarnessCatalogView<any, any, any, any, any, any>,
  HostInvocation,
  HostContext,
  const ConfiguredGroups extends readonly string[] = readonly [],
>(
  definition: HarnessDefinition<Catalog>,
  config: HostedHarnessInstanceConfig<
    Catalog['requirements'],
    ConfiguredGroups
  >,
  hostBindings: HarnessHostBindings<HostInvocation, HostContext>,
): Promise<HostedHarnessInstance<Catalog['contracts'], HostInvocation>>
```

Hosted execution extends the same private runtime kernel used by standalone
execution. The Harness definition retains its compiled graph in package-private
metadata; hosted instantiation consumes that exact graph and never recompiles a
public catalog projection. The private extension is semantically equivalent to:

```ts
declare const trustedHostedInvocationBrand: unique symbol

interface TrustedHostedInvocationEnvironment {
  readonly [trustedHostedInvocationBrand]: true
  readonly identity?: HarnessIdentity
  readonly traceContext?: HarnessTraceContext
  readonly targetDispatcher: HarnessTargetDispatcher
  readonly hostToolBindings: ReadonlyMap<object, AgentExecutableBinding>
}

interface HarnessRuntimeKernel<Contracts extends HarnessContracts<any, any>> {
  runTrusted<Target extends HostedTargetOf<Contracts>>(
    target: Target,
    input: HarnessValidatedTargetInput<Target>,
    options: HostedInvokeOptions,
    environment: TrustedHostedInvocationEnvironment,
  ): Promise<RunOutcome<HarnessTargetOutput<Target>>>
  streamTrusted<Target extends HostedTargetOf<Contracts>>(
    target: Target,
    input: HarnessValidatedTargetInput<Target>,
    options: HostedInvokeOptions,
    environment: TrustedHostedInvocationEnvironment,
  ): HarnessTargetDispatchStream<HarnessTargetOutput<Target>>
}
```

This SPI is package-private and is not exported from the package root or the
integrator entrypoint. Each hosted call creates one fresh deeply frozen
environment. Its host binding overlay is keyed by hidden definition-identity
tokens and structurally shares all non-host bindings. Only each overlay
binding's lexical handler closure captures the current `HostInvocation` and
`createHostContext`; there is no string lookup or public, global, session, or
mutable registry. The runtime retains the overlay only until the root call
settles or interrupts and removes it on startup failure, cancellation, close,
or terminal completion. Resume supplies a fresh host invocation, repeats the
trusted projection, and constructs a fresh overlay; a prior host object is
never revived.

Hosted mode supplies the host dispatcher for workflow agent calls, subagents,
and host nested targets. The root hosted target enters the shared runtime
directly after exact contract-identity validation. Ordinary `getInstance`
cannot construct the private environment and continues to reject a graph with
host tools. Host dispatchers, logger, telemetry, context-factory dependencies,
and opaque invocation values are borrowed and are never closed by Harness.

`@purista/harness/integrator` exports `createHostOwnerToken`,
`defineHostTool(hostOwner, id, definition)`, and the hosted types above. The
same opaque owner token is attached to every host tool from one host builder
and supplied in `HarnessHostBindings`. Only `createHostOwnerToken` can create a
factory-authentic token, and `defineHostTool` stores that exact object plus a
hidden definition-identity token in package-private metadata. Hosted
instantiation compares exact token identity for every host tool before runtime
resource initialization. A forged token, structurally copied host tool,
different owner, or mixed-owner graph fails closed. Neither token participates
in inspection, serialization, persistence, or a digest. `runHosted` and
`streamHosted` are the only integrator entry
points that accept `HostInvocation`. They verify the target contract identity
and receive already validated logical input before starting or reopening the
named session. They do not parse or transform the input again.

This is a deliberate hosted-boundary exception to the standalone wire-input
contract. The host adapter owns wire parsing and transformation; its validated
logical value becomes the canonical Harness root input used for session,
checkpoint, replay, and conflict comparison. Harness validates only that the
value is JSON data at hosted entry and never invokes the root input schema on
that value a second time.

`HostInvocation` is supplied only by the host target adapter for each run. It is
opaque to Harness application logic, absent from public `InvokeOptions`, never
serialized, persisted, or exposed to a model. Harness passes it only to the two
host-owned projection functions and `createHostContext`; it never reads its
properties itself. At hosted entry it invokes both projection functions exactly
once, normalizes and freezes their returns, binds the identity to the session,
and enters the root trace through the existing W3C extraction behavior before
any run event or handler. A projection throw becomes sanitized `InternalError`.
The projected identity and trace cannot be supplied or overridden by
`HostedTargetRequest`. Nested dispatch carries the frozen identity and a
trusted current W3C carrier in `HarnessTargetDispatchRequest.invocation`.
The returned context exists for one host-tool call and is
discarded afterward. Hosted instance config omits public `logger` and
`telemetry`; the host bindings replace those fields, and Harness derives
`Metrics` from the bound telemetry. Application callers cannot supply or
override host-only keys.

For a host tool selected by one agent turn, `tool.callId` is the provider's
stable tool-call id and `invocationId` is the owning agent invocation id.
Harness derives the occurrence id once as `invocation_` plus lowercase SHA-256
of the canonical JSON tuple
`['harness.host-tool-invocation.v1',rootRunId,runId,invocationId,tool.id,tool.callId]`.
That value is exposed as `hostToolInvocationId`, stored in the host frame and
nested-call lineage, and reused unchanged on resume.

For a nested call, `childInvocationId` is `invocation_` plus lowercase SHA-256
of `canonicalJson(['harness.host-child-invocation.v1',hostToolInvocationId,
callId,target.kind,target.id])`. Its session id is `session_` plus lowercase
SHA-256 of `canonicalJson(['harness.host-child-session.v1',sessionId,rootRunId,
childInvocationId,target.kind,target.id])`. Dispatch, in-process coalescing,
checkpoint lineage, and resume use those exact ids, so a crash before terminal
checkpoint commit cannot create a different logical child.

`nestedTargets.run` is scoped to the current parent run and is the only route by
which a host context may construct agent/workflow invokers. Its `callId` is
required and stable within the host-tool invocation. Harness checkpoints the
tuple `(hostToolInvocationId, callId, target kind/id, canonical JSON wire input)`,
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

The persisted host nested-call representation is exact:

```ts
interface HostNestedTargetStoredErrorV1 {
  readonly code: 'HOST_NESTED_TARGET_FAILED'
  readonly message: 'Host nested target failed.'
  readonly category: 'internal'
  readonly retriable: false
  readonly meta: Readonly<{
    reason: 'target_failed'
    agent_id: string
    tool_id: string
    tool_call_id: string
    call_id: string
    target_kind: 'agent' | 'workflow'
    target_id: string
  }>
}

class HostNestedTargetError extends HarnessError {
  readonly code: 'HOST_NESTED_TARGET_FAILED'
  readonly category: 'internal'
  readonly retriable: false
  readonly message: 'Host nested target failed.'
  readonly meta: HostNestedTargetStoredErrorV1['meta']
}

class HostNestedTargetReplayConflictError extends HarnessError {
  readonly code: 'HOST_NESTED_TARGET_REPLAY_CONFLICT'
  readonly category: 'validation'
  readonly retriable: false
  readonly message:
    'Host nested call id conflicts with an existing logical target call.'
  readonly meta: Readonly<{
    reason: 'target_mismatch' | 'input_mismatch'
    agent_id: string
    tool_id: string
    tool_call_id: string
    call_id: string
    expected_target_kind: 'agent' | 'workflow'
    expected_target_id: string
    received_target_kind: 'agent' | 'workflow'
    received_target_id: string
  }>
}

type HostNestedTargetStoredOutcomeV1 =
  | Readonly<{ status: 'completed'; output: JsonValue }>
  | Readonly<{ status: 'failed'; error: HostNestedTargetStoredErrorV1 }>
  | Readonly<{
      status: 'cancelled'
      error: Readonly<{
        code: 'OPERATION_CANCELLED'
        message: 'Host nested target call was cancelled.'
        category: 'cancelled'
        retriable: false
        meta: Readonly<{ scope: 'agent' | 'workflow' }>
      }>
    }>

interface HostNestedTargetCheckpointV1 {
  readonly schemaVersion: 1
  readonly kind: 'host_nested_target'
  readonly toolCallId: string
  readonly callId: string
  readonly target: Readonly<{
    kind: 'agent' | 'workflow'
    id: string
  }>
  readonly input: JsonValue
  readonly outcome: HostNestedTargetStoredOutcomeV1
  readonly lineage: Readonly<{
    rootRunId: string
    agentRunId: string
    hostToolInvocationId: string
    childRunId: string
    childInvocationId: string
  }>
}
```

The call checkpoint key is
`host:call:<sha256(canonicalJson(['harness.host-call-key.v1',hostToolInvocationId,callId]))>`
and its storage metadata is exactly
`{checkpointKind:'host_nested_target',schemaVersion:1}`. `callId` uses the
durable-step id grammar. The stored input is the caller's canonical JSON wire
value before the receiving target validates or transforms it.
`HostNestedTargetCheckpointV1` is stored as `RunCheckpoint.output` at the key
above. `RunCheckpoint.input` remains the canonical boundary input of the root
Harness invocation; the nested wire value exists only in the host record's
`input`. The enclosing checkpoint remains the sole owner of run, session,
lease, worker, attempt, sequence, and commit-time fields. Each create or
replacement occurs under the active root lease and advances that checkpoint's
sequence by exactly one. Host steps use the same projection with their handler
result as `RunCheckpoint.output`, the root boundary input as
`RunCheckpoint.input`, and the `host:step:` key. Neither form introduces a new
storage operation or checkpoint registry.
Target identity has conflict precedence over input. Reusing the key with
another target or input throws the exact
`HostNestedTargetReplayConflictError` above.
No input or input hash appears in an error, log, metric, or event.

Before reading an in-memory or persisted call entry, `nestedTargets.run` calls
the hosted dispatcher's side-effect-free `assertTarget` seam. That validates
the exact hidden identity against the host's immutable table, including
completed-graph and explicitly declared remote contracts. It never resolves
`(kind,id)` to gain a capability. This validation also runs on replay, so an
unknown or structurally copied target cannot obtain a saved result without
dispatch.

Completed, failed, and cancelled outcomes replay without dispatch. Concurrent
calls with the identical key, target, and input share one in-flight promise,
including its rejection. In v4 one host-tool occurrence may have at most one
distinct active nested target. A second overlapping distinct call rejects
before dispatch with
`ValidationError('Host tool can run only one nested target at a time.',
{where:'invoke_options',issues:{reason:'concurrent_host_nested_target'}})`.
Fan-out belongs in a workflow. An interrupted child has no terminal call
checkpoint; the continuation is authoritative. After child resume, Harness
commits the terminal call checkpoint and re-enters the host handler, whose
repeated `nestedTargets.run` observes the stored result. The handler's own
return value remains the host tool output; the child output is never substituted
for it.

A completed child commits its validated output before returning it. A failed
child commits the fixed `HostNestedTargetStoredErrorV1`, then throws the
reconstructed `HostNestedTargetError`; a cancelled child commits the fixed
cancelled outcome, then throws the reconstructed `OperationCancelledError`.
The handler may catch either error and continue. Re-entry and later equal calls
reconstruct the same canonical class from the validated stored outcome without
dispatch. Malformed or unavailable stored records remain storage or internal
failures and are never reported as caller replay conflicts.

`checkpointStep` uses
`host:step:<sha256(canonicalJson(['harness.host-step-key.v1',hostToolInvocationId,stepId]))>`
and otherwise has the exact `WorkflowContext.step` contract. Managed steps and
nested target calls therefore replay safely. An unmanaged effect before an
interruption may run again and remains application-owned.

A host interruption extends the existing strict continuation with this exact
frame:

```ts
interface SuspendedHostToolFrameV1 {
  readonly kind: 'host-tool'
  readonly runId: string
  readonly agentId: string
  readonly invocationId: string
  readonly hostToolInvocationId: string
  readonly toolId: string
  readonly callId: string
  readonly input: JsonValue
  readonly bindingId: string
  readonly bindingContractDigest: string
  readonly toolStarted: true
  readonly activeNestedCallIds: readonly [string]
}
```

The root-to-leaf path is ordered agent frame, host-tool frame, then child agent
or workflow continuation. Resume validates exact binding identity and digest,
resumes the child first, commits its host-call checkpoint, and re-enters the
same host binding through a fresh trusted invocation overlay. The common tool
pipeline then validates the actual host-handler output, runs `afterTool`, and
emits exactly one `tool.finished` without another `tool.started`. Cancellation
propagates to the child and follows the same re-entry/replay rules.

Hosted instantiation is also pure and deterministic until all configuration
has passed. It stops at the first failure in this order:

1. require an exact package-owned Harness definition and its compiled graph;
2. require `hostBindings` to be a non-array object;
3. reject its lexicographically first unknown key;
4. require and validate `hostOwner`, `targetDispatcher`, `projectIdentity`,
   `projectTraceContext`, `createHostContext`, `logger`, then `telemetry`;
5. require a factory-authentic host-owner token;
6. compare that token with host tools in lexicographic tool-id order;
7. validate hosted runtime config with standalone steps 2 through 8, followed
   by admissions, while allowing host-tool requirements and treating `logger`
   and `telemetry` as unknown hosted config keys; and
8. initialize shared Harness resources in the normal transactional order.

Host-binding failures are `HarnessConfigError`. A missing field uses
`{reason:'missing_host_binding',path}`, an unknown key uses
`{reason:'unexpected_host_binding',path}`, and a malformed field or forged
token uses `{reason:'invalid_host_binding',path}`. Exact owner mismatch uses the
`host_owner_mismatch` error below. Hosted runtime-config failures retain the
ordinary instance-config reasons and paths. No initializer, adapter, projector,
storage operation, or dispatcher runs before this validation completes.

Hosted entry validation is stable and stops at the first failure:

1. require an open instance;
2. validate request shape and exact hidden target identity;
3. validate the already transformed logical input as JSON data;
4. reject host-owned `traceparent`, then `tracestate`, when present through an
   erased type;
5. honor a pre-aborted signal;
6. project and normalize identity;
7. project and normalize trace context;
8. compare session identity;
9. open or reacquire the checkpoint/lease; and
10. execute or dispatch.

An unknown or copied target is
`ValidationError('Hosted target is not part of this Harness graph.',
{where:'invoke_options',issues:{reason:'unknown_hosted_target'}})`. A caller
trace field is
`ValidationError('Hosted invocation cannot supply host-owned trace context.',
{where:'invoke_options',issues:{reason:'host_owned_trace_context',field}})`.
Projection throws are sanitized as `InternalError` with fixed messages
`Hosted identity projection failed.` or
`Hosted trace-context projection failed.`. Invalid projection returns use the
existing canonical identity or trace normalization errors. Owner mismatch is a
`HarnessConfigError` with message
`Host tool owner does not match the hosted Harness owner.` and exact metadata
`{reason:'host_owner_mismatch',path:'hostBindings.hostOwner',id}` for the
lexicographically first mismatched tool. Pre-abort invokes no projector,
storage, or dispatcher; projection failure invokes no storage or dispatcher.

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

`acquire` may reject capacity only with `AgentAdmissionRejectedError`. Its code
is `AGENT_ADMISSION_REJECTED`, category is `admission`, fixed message is `Agent
admission capacity is exhausted.`, `retriable` is always `true`, and safe
metadata is exactly `{reason:'capacity_exhausted',retryAfterMs?}`.
`retryAfterMs`, when present, is a positive safe integer. Invalid construction
or adapter configuration fails with `HarnessConfigError`; callers cannot add
another reason or content-bearing metadata. Any other adapter throw normalizes
to the sanitized `InternalError`. Existing cancellation and inherited deadline
errors retain their canonical cancellation or timeout identity.

H4-006 adds `admission` to the public `ErrorCategory` union and owns this
adapter-author-facing constructor:

```ts
class AgentAdmissionRejectedError extends HarnessError {
  constructor(options?: Readonly<{ retryAfterMs?: number }>)
}
```

H4-011 exports it from the package root. A lease `release` is called exactly
once after the logical result is prepared and before `run.finished`. Release
has no cancellation signal. Any release throw becomes a sanitized
`InternalError` and replaces the pending completed/interrupted/cancelled
terminal outcome. A durable checkpoint or completed run record remains intact;
repeating that root invocation retries delivery and release without repeating
model, tool, or workflow effects. The runtime records a content-free cleanup
diagnostic. This makes capacity leaks visible without corrupting the saved
logical result.

## 10. Invocation, streaming, and approval

Definition `durable: true` has the same meaning for an agent and a workflow:
every invocation of that target is lease-backed and recoverable, and durable
Harness storage is an instance requirement. `InvokeOptions.durable` supplies
caller-owned durable identity/options; it does not switch durability on. When
it is omitted for a durable target, Harness generates `run_<ulid>`, uses the
instance's single opaque `worker_<ulid>`, the reserved root step id
`harness:root:v1`, and attempt `1`. When present, its `runId`, optional
`workerId`, optional `stepId`, optional `attempt`, and optional narrowed
workspace policy are used after strict validation; omitted members resolve to
those same Harness-owned defaults. Supplying it to a target that did not
declare `durable: true` is
`ValidationError{where:'invoke_options',issues:{reason:'target_not_durable'}}`
before storage or target execution. `context.externalWait` exists only on a
workflow declared durable. Definition `workspace: true` enables a workspace
for the target; per-run `DurableInvokeOptions.workspacePolicy` may narrow the
declared constraint but cannot create the capability.

A non-durable agent for which
`compiledGraph.approval.agents[agentId].reachable` is true, or non-durable
workflow for which `compiledGraph.approval.workflows[workflowId].reachable` is
true, remains an ordinary ephemeral authoring target, but each root invocation
uses an approval-recovery lease. Guardrail `requirements.durable:true` requires
storage but does not select this approval-recovery lifecycle. After raw JSON input validation and
session locking, and before `run.started`, model, workflow, or tool activity,
Harness creates the revision-one run, reads that authoritative record and the
absent `harness:root:v1` checkpoint, and submits spec 32's exact
`AcquireRunRequest{mode:'initial',...}` with generated `run_<ulid>`, the
instance `worker_<ulid>`, deterministic acquisition id, and requested attempt
`1`. Durable targets use the same initial acquisition contract with their
validated durable ids/options. Thus every
possible approval effect is already fenced. A target with neither
`durable:true` nor approval reachability uses the ordinary unleased
`createRun`/`finishRun` lifecycle.

Both durable-target and approval-recovery invocations commit the interruption
checkpoint at `harness:interrupt:v1` under the active lease, then release the
lease; release marks the run `interrupted`. A crash after checkpoint commit but
before release leaves no unfenced effect: another worker waits for lease expiry
and reacquires the same run/checkpoint. Resume uses `ToolApprovalResume.runId`
to read the authoritative run first. A terminal run validates its
`TerminalApprovalReceiptV1` and either replays, conflicts, or reports a stale
continuation without lease acquisition. That path validates the requested
session and root invoker against `RunRecord.sessionId/kind/target`, compares the
canonical pre-transform input with required `RunRecord.input`, and compares
interrupt id, deployment revision, compiled graph digest, and session identity
digest with the receipt before event/decision equality. For a non-terminal
resumable run, Harness optimistically reads and validates the record and
`harness:interrupt:v1` checkpoint, then submits spec 32's exact
`AcquireRunRequest{mode:'resume',expected:{revision,status,checkpoint:{stepId,
sequence}},...}`. The returned post-CAS record/checkpoint snapshot is the
under-lease reread and must be byte-equivalent to the optimistic identity and
checkpoint before replacement or effects. The new lease/attempt identity is
used for every replacement. Completion, failure, and
cancellation use `finalizeRun`; `replaceCheckpoint` and `finalizeRun` are never
called without the currently active matching lease. A resume/finalization
storage failure executes no new effect after the failed fence and is exposed as
the canonical storage error. There is no unleased approval checkpoint path.

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

Approval-resume streams use the exact persisted-start replay contract from
spec 12: the original sequence-one `run.started` is the first iterator item but
is never appended, broadcast, or counted again; newly produced events retain
the checkpoint's next unused sequence. Terminal receipt replay similarly
returns only the stored start and terminal events without reopening execution.

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

The UI adapter keeps one AI SDK step per provider turn. `run.started` emits the
message `start` and status only; it does not open a step. The first
`output.text.delta` or `output.object.snapshot` for a new model stream id opens
`start-step` and that stream's part. If a turn has no assistant output,
`model.completed` opens its step. The first event belonging to another model
stream id closes any active text/object part, emits `finish-step` for the prior
turn after its tool activity, and opens the next `start-step`. Tool and approval
events after `model.completed` remain inside that completed provider turn until
the next turn starts or the run terminates. `run.finished` closes active parts,
closes the active step, and emits the final message finish. Guarded terminal
output is valid after its `model.completed` event and before `run.finished`;
the matching stream id keeps it in that same turn. This state machine represents
`text -> tool -> text` as ordinary AI SDK steps without inventing custom chunks.

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
Approval descriptors carry root run id, executing agent run id, interrupt id,
revision, event id, approval ids, and the stable session id required to reopen
the same run. Invalid, incomplete, stale, duplicated, or mixed-run decisions
fail before invocation.

The v1 event mapping is fixed:

| Harness event | AI SDK UI v1 chunks |
| --- | --- |
| `run.started` | `start`, `data-status{phase:'started'}` |
| first output or `model.completed` for a model stream id | close the prior turn when present, then `start-step` for this provider turn |
| `output.text.delta` | one `text-start` per stream id, then ordered `text-delta`; `text-end` when the provider turn or run closes |
| `output.object.snapshot` | transient `data-output` with stable run/output id |
| `tool.input.available` | standard dynamic `tool-input-available` |
| `tool.started` | `data-status{phase:'tool-running'}` |
| successful `tool.finished` | standard dynamic `tool-output-available` |
| failed `tool.finished` | standard dynamic `tool-output-error` with sanitized text |
| terminal tool approval interrupt | standard `tool-approval-request` for every approval plus `data-status{phase:'interrupted'}` |
| `approval.responded` | standard `tool-approval-response` |
| `output.file` | standard `file` chunk with URL and media type |
| `output.progress` | `data-status{phase:'media-progress'}` |
| completed `run.finished` | close active parts, completed status, `finish-step` when open, `finish{finishReason:'stop'}` |
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

The public approval request is exact:

```ts
interface ToolApprovalRequest {
  readonly approvalId: string
  readonly runId: string
  readonly agentRunId: string
  readonly parentRunId?: string
  readonly parentInvocationId?: string
  readonly agentId: string
  readonly workflowId?: string
  readonly invocationId: string
  readonly step: number
  readonly toolId: string
  readonly callId: string
  readonly input: JsonValue
  readonly demands: readonly DecisionEvidence[]
}
```

The decision engine derives each approval id from the ordered tuple
`[rootRunId,agentRunId,invocationId,'approval',step,toolId,callId,orderedDemandDecisionIds]`.
Operational approval events use the executing agent run as their common event
`runId`; the interrupt descriptor and request retain the root id for the public
resume operation.

H4-005 preflights the complete provider tool-call batch in call order before
any handler starts. The transformed wire arguments and once-parsed effective
input are distinct immutable values. Its resumable per-agent turn state uses
only data, never closures or definition objects:

```ts
type PreparedToolCheckpointEntryV1 =
  | Readonly<{
      state: 'recoverable'
      call: ToolCallSpec
      argumentsStage: 'provider' | 'transformed'
      error: SerializedError
    }>
  | Readonly<{
      state: 'denied'
      call: ToolCallSpec
      input: JsonValue
      error: SerializedError
    }>
  | Readonly<{
      state: 'ready'
      call: ToolCallSpec
      input: JsonValue
      bindingId: string
      bindingContractDigest: string
      approvalId?: string
    }>
  | Readonly<{
      state: 'completed'
      call: ToolCallSpec
      input: JsonValue
      bindingId: string
      bindingContractDigest: string
      toolStarted: true
      outcome:
        | Readonly<{ status: 'completed'; output: JsonValue }>
        | Readonly<{ status: 'failed'; error: SerializedError }>
      modelMessage: Extract<ModelMessage, { role: 'tool' }>
    }>
  | Readonly<{
      state: 'suspended-child'
      call: ToolCallSpec
      input: JsonValue
      bindingId: string
      bindingContractDigest: string
      toolStarted: true
      childInvocationId: string
      childRunId: string
    }>

interface SuspendedAgentTurnStateV1 {
  readonly rootRunId: string
  readonly agentRunId: string
  readonly sessionId: string
  readonly agentId: string
  readonly workflowId?: string
  readonly parentRunId?: string
  readonly parentInvocationId?: string
  readonly invocationId: string
  readonly step: number
  readonly modelAlias: string
  readonly input: JsonValue
  readonly messages: readonly ModelMessage[]
  readonly providerContinuation?: ProviderContinuation
  readonly entries: readonly PreparedToolCheckpointEntryV1[]
  readonly agentStarted: true
}

type AcceptedModelTurnOperationV1 =
  | 'text'
  | 'object'
  | 'textStream'
  | 'objectStream'

interface PersistedAgentModelRequestV1 {
  readonly messages: readonly ModelMessage[]
  readonly tools: readonly ModelToolSpec[]
  readonly schema?: JsonValue
  readonly call?: ModelCallOptions
}

type PersistedAgentModelResponseV1 =
  | Readonly<{
      content: string
      toolCalls: readonly ToolCallSpec[]
      usage: TokenUsage
      finishReason: FinishReason
      outcome?: ModelOutcome
    }>
  | Readonly<{
      object: JsonValue
      toolCalls: readonly ToolCallSpec[]
      usage: TokenUsage
      finishReason: FinishReason
      outcome?: ModelOutcome
    }>

type AgentModelResponse =
  | Readonly<PersistedAgentModelResponseV1 & {
      readonly providerContinuation?: ProviderContinuation
    }>

interface AcceptedModelTurnCursorV1 {
  readonly schemaVersion: 1
  readonly kind: 'accepted_model_turn'
  readonly phase: 'after_model' | 'continue_turn'
  readonly rootRunId: string
  readonly agentRunId: string
  readonly sessionId: string
  readonly agentId: string
  readonly workflowId?: string
  readonly parentRunId?: string
  readonly parentInvocationId?: string
  readonly invocationId: string
  readonly step: number
  readonly modelAlias: string
  readonly input: JsonValue
  readonly mode: 'run' | 'stream'
  readonly operation: AcceptedModelTurnOperationV1
  readonly streamId?: string
  readonly request: PersistedAgentModelRequestV1
  readonly response: PersistedAgentModelResponseV1
  readonly providerContinuation?: ProviderContinuation
  readonly agentStarted: true
}

type AgentContinuationStateV1 =
  | SuspendedAgentTurnStateV1
  | AcceptedModelTurnCursorV1

interface WorkflowAgentCallBudgetStateV1 {
  readonly schemaVersion: 1
  readonly usedCalls: number
}

type SuspensionFrameV1 =
  | Readonly<{
      kind: 'agent'
      runId: string
      invocationId: string
      state: AgentContinuationStateV1
    }>
  | Readonly<{
      kind: 'workflow'
      runId: string
      workflowId: string
      invocationId: string
      input: JsonValue
      activeCallIds: readonly string[]
      agentCallBudget: WorkflowAgentCallBudgetStateV1
    }>
  | SuspendedHostToolFrameV1

interface SuspensionNodeV1 {
  readonly frame: SuspensionFrameV1
  readonly children: readonly SuspensionNodeV1[]
}

interface HarnessInterruptionCheckpointV1 {
  readonly schemaVersion: 1
  readonly rootRunId: string
  readonly sessionId: string
  readonly rootTarget: Readonly<{ kind: 'agent' | 'workflow'; id: string }>
  readonly deploymentRevision: string
  readonly compiledGraphDigest: string
  readonly sessionIdentityDigest: string
  readonly interrupt: HarnessInterrupt
  readonly continuation: SuspensionNodeV1
  readonly priorResumeReceipt?: ApprovalResumeReceiptV1
  readonly nextEventSequence: number
  readonly startedAgentRunIds: readonly string[]
}
```

The root interruption checkpoint is stored as `RunCheckpoint.output` at the
single reserved step id `harness:interrupt:v1`. Its `RunCheckpoint.input` is the
root target's canonical JSON wire input captured before the Standard Schema
validator or any transforming schema runs. The transformed validated input used
by execution remains inside the appropriate continuation frame. Metadata is exactly
`{checkpointKind:'harness_interruption',schemaVersion:1}`. The checkpoint's
`sequence` is the next global checkpoint sequence for that run, while
`nextEventSequence` is the next portable event sequence and therefore belongs
to the execution protocol rather than the storage adapter. Every workflow
frame stores the accepted H4-007 `WorkflowAgentCallBudgetStateV1` returned by
that workflow runtime. H4-008 restores that state into H4-007; it does not
derive `usedCalls` from children, events, or completed checkpoints.

`priorResumeReceipt` is absent on the first interruption. If resuming the
current pending checkpoint produces another interruption, its
`ApprovalResumeReceiptV1` becomes the new pending checkpoint's sole
`priorResumeReceipt`. Retrying that receipt's exact event and normalized
decisions returns the current interrupted `RunOutcome` represented by this
checkpoint without acquiring a lease, emitting an event, rerunning a schema,
or executing an effect. Reusing its event id with changed decisions is
`event_conflict`. For a pending checkpoint, Harness selects the bounded
approval context before comparing revision or digest values: the supplied
`interruptId` selects the current `interrupt.interruptId`, or it selects the
`priorResumeReceipt.interruptId` when that receipt is present. The prior-receipt
path requires the same `resumeEventId`; another event is `stale_continuation`.
Any other well-formed interrupt id for this already established root run is
also `stale_continuation`, because it can only address an unretained consumed
or otherwise non-current continuation. A different new event may resume only
the checkpoint's current interrupt. If it reuses the retained prior receipt's
event id, it is `event_conflict`; otherwise its complete decision set is
validated before execution. When another resume produces a third interruption,
the previous field is replaced rather than chained. H4-008 therefore retains
at most the current interruption and one immediately consumed receipt; it
promises no replay for older approval events and reports them as stale without
retaining an unbounded history.

One approval resume moves the same step through two exact checkpoint states.
`AppliedApprovalDecisionV1` and `ApprovalResumeReceiptV1` are the single
canonical receipt representations owned by spec 32:

```ts
interface HarnessResumingInterruptionCheckpointV1 {
  readonly schemaVersion: 1
  readonly kind: 'harness_interruption_resuming'
  readonly rootRunId: string
  readonly sessionId: string
  readonly interruptId: string
  readonly resumeEventId: string
  readonly decisions: readonly AppliedApprovalDecisionV1[]
  readonly deploymentRevision: string
  readonly compiledGraphDigest: string
  readonly sessionIdentityDigest: string
  readonly continuation: SuspensionNodeV1
  readonly nextEventSequence: number
  readonly startedAgentRunIds: readonly string[]
}

interface HarnessPostApprovalCheckpointV1 {
  readonly schemaVersion: 1
  readonly kind: 'harness_post_approval'
  readonly rootRunId: string
  readonly sessionId: string
  readonly interruptId: string
  readonly resumeEventId: string
  readonly decisions: readonly AppliedApprovalDecisionV1[]
  readonly deploymentRevision: string
  readonly compiledGraphDigest: string
  readonly sessionIdentityDigest: string
  readonly continuation: SuspensionNodeV1
  readonly nextEventSequence: number
  readonly startedAgentRunIds: readonly string[]
}
```

The pending checkpoint is atomically replaced by the resuming checkpoint before
the first `approval.responded` or approved tool effect. Decisions are sorted by
`approvalId`; their optional application comments are never stored. The
resuming checkpoint is replaced after every completed tool or child transition,
so replay observes completed entries and never repeats an effect. It may retain
`SuspendedAgentTurnStateV1.providerContinuation` only until the first subsequent
provider request using that continuation returns one validated response or
valid stream finish. Before `afterModel`, final-output rails, tool-batch
preparation, or another effect, the runtime atomically replaces it with
`HarnessPostApprovalCheckpointV1`. The resumed leaf agent frame then contains
one `AcceptedModelTurnCursorV1`; the consumed continuation is absent from its
request and every other field. The cursor's optional `providerContinuation` is
only the newly returned continuation from that accepted response.

The cursor is a strict normalized model-turn snapshot. `operation` is exactly
`text` for aggregate text, `object` for aggregate structured output,
`textStream` for streamed text, and `objectStream` for streamed structured
output. `mode`, `operation`, and the agent contract must agree. `streamId` is
required exactly for `textStream` and `objectStream` and absent otherwise. The
request is the exact sanitized effective provider-neutral `AgentModelRequest`
after `beforeModel`: all and only `messages`, `tools`, optional `schema`, and
optional `call` are retained. Harness
recursively clones and freezes that projection. Every value, including
`call.providerOptions`, must be JSON; otherwise the resumed request fails with
`ValidationError{where:'model_request',issues:{reason:'non_json_model_call_options'}}`
before provider I/O. The persisted messages
deliberately strip the consumed `providerContinuation`; Harness attaches that
old continuation only to the private provider request constructed from the
resuming agent state. As a clean-break correction, public
`AgentModelRequest.schema` becomes optional. It is absent exactly for `text`
and `textStream`, and required exactly for `object` and `objectStream`; the
cursor validator correlates that presence with `operation`. Tools and any
schema are the exact effective post-exposure, post-`beforeModel` projections,
not recomputed definitions.

The public `AgentAfterModelInterceptorContext.response` changes from the stale
object-only type to `AgentModelResponse`. Its text member contains `content`;
its structured member contains `object`; both contain the frozen ordered
`toolCalls`, `usage`, `finishReason`, optional normalized `outcome`, and optional
new `providerContinuation`. They never contain `raw`, the opposite mode's
content field, or another property. `PersistedAgentModelResponseV1` is exactly
that sanitized immutable union with `providerContinuation` removed. The
cursor's separate optional continuation is reattached when constructing the
`AgentModelResponse` passed to `afterModel`. Live and resumed paths use the same
projection and reattachment functions, so the callback sees byte-equivalent
request and response values. The consumed old continuation is never visible;
only the new response continuation is visible when present. Text operations
select the content member, and object operations select the object member. The
new continuation passes the provider-continuation validator against
`response.toolCalls` before cursor commit. The complete correlation tuple is
`[rootRunId,agentRunId,sessionId,agentId,workflowId,parentRunId,
parentInvocationId,invocationId,step,modelAlias,mode,operation,streamId]`; every
identifier and optional-parent relationship must match its frame and root
checkpoint.

The cursor is private checkpoint state. Its request, response, output, tool
arguments, schemas, and opaque continuation are never copied into inspection,
events, logs, errors, telemetry attributes, or storage conflict metadata.
Storage deployment controls treat it as persisted prompt/application content.

`phase:'after_model'` means the accepted response is durable and `afterModel`
has not run. Let `E` be the `HarnessPostApprovalCheckpointV1.nextEventSequence`
that encloses the cursor. The exact resumed-turn order is:

```text
replace checkpoint with after_model cursor at nextEventSequence E
-> append and deliver deterministic model.completed at sequence E
-> invoke afterModel with the cursor projections
-> replace checkpoint with continue_turn cursor at nextEventSequence E + 1
```

The `model.completed.eventId` uses the canonical Harness event tuple with this
same run id, sequence, and type. Its operation, model alias, optional stream id,
usage, and finish reason are derived only from the cursor. Append is exact-
duplicate idempotent. Live delivery uses the already assigned event and never
allocates or advances another sequence. The `after_model` checkpoint retains
`E` until `afterModel` succeeds. Therefore a restart after cursor commit but
before the `continue_turn` replacement idempotently appends or reads the same
persisted event and delivers that event to the new resume stream before running
`afterModel`; it does not create a second logical event. Only the fenced
`continue_turn` replacement advances `nextEventSequence` to `E + 1`. A restart
from `continue_turn` emits neither `model.completed` nor `afterModel` again and
continues by preparing the stored ordered tool calls, or by applying the normal
final-output path when the list is empty.

A crash before the initial `after_model` cursor replacement may repeat
`beforeModel`, the external provider request, and any provisional non-persisted
stream chunks already delivered, because no local transaction can atomically
commit a remote response. Once that cursor replacement commits, that provider
turn and its provisional chunks never execute again. A crash after
`model.completed` append or delivery but before the `continue_turn` replacement
may redeliver the same deterministic event on the new resume stream and may
repeat `afterModel`; no second event is appended. Once the `continue_turn`
replacement commits, `afterModel` is protected from replay. Stateful
Guardrail callbacks must be idempotent for their stable occurrence during the
remaining callback-to-checkpoint crash window. No tool preparation or tool
effect begins before the `continue_turn` replacement, and every later tool or
child effect remains protected by the existing fenced prepared-entry
transitions. Harness does not claim a distributed transaction with external
providers, stream consumers, or application callbacks.

The cursor is consumed only into a terminal `finalizeRun`, a new pending
interruption checkpoint, or a fenced post-approval continuation containing the
completed prepared entries required for the next model turn. If the stored
response creates another approval interruption, its new continuation moves
from the cursor into that new pending agent state; it is never copied or
chained. A later interruption atomically replaces the step with the new pending
checkpoint. Root terminal
commit calls spec 32 `finalizeRun` with the exact sorted
`TerminalApprovalReceiptV1` for the consumed interrupt; the same transaction
writes that receipt into the terminal `RunRecord`, appends the matching
deterministic `run.finished`, deletes every checkpoint, and releases the lease.
That terminal receipt is the sole restart-safe source
for equal-event replay, changed-event conflict, and new-event stale-continuation
decisions after checkpoint deletion. There is no second checkpoint store or
approval registry.

All checkpoint variants are strict, versioned, frozen after validation, and
reject unknown keys. A replacement retains the same run, session, lease,
worker, step id, root input, and attempt and advances the checkpoint sequence by
exactly one. The storage operations and fencing semantics are owned by spec 32.

For `denied`, `ready`, `completed`, and `suspended-child`, stored
`call.arguments` is the post-`beforeTool` JSON wire value used in the assistant
tool-call continuation. A `recoverable` entry rejected before binding or rails
stores the canonical JSON provider arguments exactly as received and sets
`argumentsStage:'provider'`; one that reached `beforeTool` stores the transformed
wire arguments and sets `argumentsStage:'transformed'`. Original pre-rail
arguments are never retained after a transform succeeds. `input` is the one schema-parsed value
shared by policy, approval, and the handler. `messages` is the exact canonical
transcript through that assistant tool-call turn after recursively removing
every `providerContinuation` property; the separate field on the active
`SuspendedAgentTurnStateV1` or `AcceptedModelTurnCursorV1` is its only persisted
representation. Intermediate assistant text or object content from a tool turn
is excluded from canonical history. The provider-neutral assistant tool-call
envelope and completed tool-result messages remain, because they are required
to continue the loop. The optional opaque provider continuation is sensitive
checkpoint-only state required by providers that
cannot continue a tool turn from canonical messages alone. It is excluded from
transcript history, events, logs, inspection, errors, and public outcomes, and
is deleted with the terminal checkpoint. This narrow persistence exception
prevents re-running the model and approving a different call after a process
restart. Storage deployment controls apply to it like other persisted prompt
state.

`completed.modelMessage` is exactly the provider-neutral tool-result subtype
`{role:'tool',toolCallId:string,content:string}`. The checkpoint validator walks
every message, accepted request/response, and completed entry recursively and
rejects a `providerContinuation` property anywhere except the active
`SuspendedAgentTurnStateV1.providerContinuation` in pending/resuming execution,
or `AcceptedModelTurnCursorV1.providerContinuation` in a post-approval
checkpoint. Those alternatives are mutually exclusive for one leaf.

The continuation is an ordered tree because one bounded parallel batch may
have more than one interrupted descendant. Each root-to-leaf path is the exact
suspension stack for that descendant. Children retain provider call order for
agent tools and declared invocation order for workflow or host calls. Shared
parent state appears once. Completed sibling entries retain their validated
model-visible outcome and are never invoked or emitted again. A
`suspended-child` entry records that `tool.started` already occurred, so resume
does not emit it twice. Multiple leaf approval requests are collected into the
one root interrupt and require one complete decision set.

The package-private `resumePreparedAgentToolBatch` is the sole resumed-batch
entrypoint. It receives the original ordered `PreparedToolCheckpointEntryV1[]`
and the complete normalized decisions. It never calls `prepareAgentToolBatch`,
`beforeTool`, tool-input parsing, permission, governance, audit, or
`approval.requested` again. It resolves each executable binding in the owning
agent's private map and verifies both `bindingId` and
`bindingContractDigest`. Approved and previously ungated `ready` entries
execute through the common pipeline; rejected entries become the defined
recoverable approval result without `tool.started`. `completed`, `denied`, and
`recoverable` siblings reuse their stored result and emit no event or effect.
The returned model-visible tool-message tail is rebuilt once in original
provider-call order and replaces the current batch tail; stored completed
sibling messages are not appended a second time.

For a `suspended-child`, H4-008 first resumes its leaf through the shared strict
target-stream consumer. The common pipeline then resumes after
`invokeValidated`: it performs the binding's required output validation,
`afterTool`, exactly one `tool.finished`, and the normal entry observer. It does
not invoke the binding or emit another `tool.started`. The original provider
batch length, including completed, denied, recoverable, ready, and
`suspended-child` entries, consumes the agent's tool-call budget exactly once;
the original entries whose binding kind is subagent consume the subagent-call
budget exactly once. Resume never derives either charge only from entries that
still require execution.

H4-005 owns suspended agent-frame creation and prepared-entry state
transitions. H4-008 owns `AcceptedModelTurnCursorV1`, its fenced phase changes,
and the resumed-batch completion seam above. H4-006
owns child links and subagent resume routing. H4-007 owns workflow re-entry
through saved `context.step` and child-call results. H4-009 owns host-tool
re-entry through `checkpointStep` and `nestedTargets.run`; unmanaged host or
workflow side effects remain application-owned. H4-008 owns the root tree,
strict schema/version validation, storage, event sequence, lifecycle set, and
terminal deletion.

Resume uses one exact optimistic-read and fenced-recheck sequence. It first
reads the `RunRecord` and current `harness:interrupt:v1` checkpoint, when one
exists, and performs every side-effect-free validation through receipt/event
and decision equality. A terminal receipt replay returns here without acquiring
a lease. For a resumable run, Harness then calls spec 32 `acquireRun` with the
optimistically observed record revision/status and reserved checkpoint
step/sequence. The returned `DurableRunLease.run` and checkpoint snapshot are
the atomic under-lease reread. Harness requires the returned record to be
`running` under that exact worker/attempt/lease result, with the same immutable
session/target/input identity and byte-equivalent checkpoint value it validated
optimistically. Acquisition must have consumed that exact expectation. It
repeats strict checkpoint, receipt/event, digest,
target, root-input, and decision validation before emitting an event or
executing an effect. A changed or missing value is
`ApprovalResumeError{reason:'invalid_checkpoint'}`. Only the successfully
revalidated lease holder may replace the checkpoint or continue execution.

Any validation failure after lease acquisition releases that lease before it
rejects. If release succeeds, the original canonical validation error retains
its identity. If release also fails, Harness attempts no effect and rejects one
`AggregateError` with fixed message
`Harness approval resume validation failed and lease release failed.` Its
`errors` array is exactly the original validation error followed by the
content-free normalized lease-release error, and its `cause` is the validation
error. Raw storage messages and checkpoint or application content are never
exposed.

On resume, H4-008 validates root, session, interrupt, revision, event, and the
complete decision set. It reopens the exact root target and continuation tree,
requires the same deployment revision and compiled graph digest, and compares
the session record's normalized identity digest. Every binding resolves only in
its owning agent's private immutable binding map and must match the stored
contract digest.
An in-process resume also requires the same hidden definition identity token.
A mismatch fails closed as stale continuation. The invoker's required `input`
argument is first checked as JSON data and canonically encoded without invoking
the target schema. Its bytes must equal the authoritative
`RunCheckpoint.input`; otherwise resume fails with
`ApprovalResumeError{reason:'input_mismatch'}` before any schema transform,
handler, model, event, or effect. The original transformed input is restored
from the continuation. This prevents a non-idempotent transforming schema from
changing resume identity or running twice. No resume reruns
`beforeTool`, input parsing, the root input schema, permission, governance, audit, or
`approval.requested`. A post-approval cursor also prevents a committed accepted
model turn from calling the provider or `beforeModel` again and resumes at its
stored phase. One `approval.responded` is emitted for each accepted
boolean decision. Approved and ungated ready entries execute; rejected entries
become recoverable approval tool errors without `tool.started`. A leaf child is
resumed first. Each suspended parent agent then completes the existing tool
occurrence with output validation, `afterTool`, and one `tool.finished` before
continuing its model loop. Workflow and host frames re-enter their handlers and
obtain completed or resumed nested calls from the checkpoint APIs. Execution
uses the fixed boundary order:

```text
beforeTool -> input parse once -> permission/governance/audit -> approval
-> tool.started -> invokeValidated -> output parse once -> afterTool
-> tool.finished
```

Resume validation is side-effect free and stops at the first failure in this
order: strict `ToolApprovalResume`/invoke-option shape, identifier grammar, and
raw JSON input; session, root run, and root target; canonical pre-transform
root input; select the terminal receipt, current pending interrupt, or retained
immediately-prior receipt by interrupt id (a non-current pending id is stale as
defined above); deployment revision; compiled graph and session identity
digests; persisted checkpoint kind/version; selected receipt or pending
`eventId` handling; then the complete approval decision set. It uses `ApprovalResumeError` and the
exact reasons in spec 15. A repeated `eventId` with byte-identical normalized
decisions returns the terminal result recorded with its strict approval receipt,
replays the already committed logical outcome, or rejoins the one live
resume promise. Reusing that `eventId` with different decisions is
`event_conflict`. A new event for an already consumed interrupt is
`stale_continuation`. Decision validation rejects duplicate ids, then sorts by
approval id and requires exactly one boolean decision for every requested
approval with no missing or unknown id; any mismatch is
`decision_set_mismatch`. Application-owned `reason` text is accepted by the
public parser but excluded from comparison, checkpoints, events, errors, and
runtime policy.

The runtime resumes all leaves before their parents. Within a parent, children
are visited in stored order. It replaces each parent frame only after the
resumed child terminal has been validated and installed. Completed siblings,
prepared preflight, `approval.requested`, `tool.started`, model turns, and
managed checkpoint effects are replayed from state and are never emitted or
executed again. A failure during leaf resume leaves the last fenced checkpoint
authoritative; the same event rejoins or replays from it rather than beginning
a second resume attempt.

The three checkpoint digests use the same canonical encoder and lowercase
`sha256:` rendering. Their preimages are exact and version tagged.

```ts
type GraphDefinitionDigestV1 =
  | readonly [
      kind: 'tool' | 'built-in-tool' | 'host-tool' | 'skill'
        | 'mcp-server' | 'agent' | 'workflow' | 'model-alias',
      id: string,
    ]
  | readonly ['mcp-tool', ownerServerId: string, localToolId: string]

type GraphToolReferenceDigestV1 =
  | readonly [kind: 'tool' | 'built-in-tool' | 'host-tool', id: string]
  | readonly ['mcp-tool', ownerServerId: string, localToolId: string]

type GraphEdgeDigestV1 =
  | readonly ['agent-model', agentId: string, modelAlias: string]
  | readonly [
      'agent-tool',
      agentId: string,
      modelFacingId: string,
      target: GraphToolReferenceDigestV1,
    ]
  | readonly ['agent-skill', agentId: string, skillId: string]
  | readonly [
      'agent-subagent',
      agentId: string,
      modelFacingName: string,
      childAgentId: string,
    ]
  | readonly [
      'agent-memory-embedding-model',
      agentId: string,
      modelAlias: string,
    ]
  | readonly [
      'agent-memory-summary-model',
      agentId: string,
      modelAlias: string,
    ]
  | readonly [
      'workflow-agent',
      workflowId: string,
      localKey: string,
      agentId: string,
    ]
  | readonly [
      'workflow-model',
      workflowId: string,
      localKey: string,
      modelAlias: string,
    ]
  | readonly [
      'mcp-tool-owner',
      ownerServerId: string,
      localToolId: string,
    ]

type SandboxPolicyDigestV1 =
  | readonly ['inherit']
  | readonly ['private']
  | readonly ['group', id: string]

type PermissionPolicyDigestV1 = readonly [
  mode: 'allow' | 'require_approval' | 'deny',
  allowPatterns: readonly string[] | null,
  denyPatterns: readonly string[] | null,
]

type AgentPermissionsDigestV1 = readonly [
  bash: PermissionPolicyDigestV1 | null,
  write: PermissionPolicyDigestV1 | null,
  edit: PermissionPolicyDigestV1 | null,
]

type NativeGovernanceRuleDigestV1 = readonly [
  id: string,
  toolKeys: readonly string[] | null,
  effect: GovernanceEffect,
  reasonCode: string | null,
  hasPredicate: boolean,
]

type GovernancePolicyDigestV1 =
  | readonly [
      'native',
      id: string,
      version: string | null,
      rules: readonly NativeGovernanceRuleDigestV1[],
    ]
  | readonly [
      'external',
      id: string,
      version: string | null,
      engine: string | null,
      declaredEffects: readonly GovernanceEffect[],
    ]

type GovernanceExposureRuleDigestV1 = readonly [
  id: string,
  toolKeys: readonly string[] | null,
  effect: GovernanceExposureEffect,
  hasPredicate: boolean,
]

type GovernanceManifestDigestV1 = readonly [
  enabled: boolean,
  mode: GovernanceMode,
  defaultEffect: 'allow' | 'deny',
  policies: readonly GovernancePolicyDigestV1[],
  exposure: readonly [
    id: string | null,
    version: string | null,
    defaultEffect: GovernanceExposureEffect,
    rules: readonly GovernanceExposureRuleDigestV1[],
  ] | null,
  hasAuditSink: boolean,
]

type GuardrailManifestDigestV1 = readonly [
  phases: readonly DecisionPhase[],
  tools: readonly string[],
  models: readonly (readonly [
    alias: string,
    capabilities: readonly ModelCapability[],
  ])[],
  memory: readonly MemoryCapability[],
  sandbox: readonly SandboxCapabilityId[],
  skillRuntimes: readonly SkillRuntimeId[],
  durable: boolean,
  workspace: boolean,
  artifacts: boolean,
]

type AgentTargetPolicyDigestV1 = readonly [
  'agent',
  id: string,
  model: string,
  loop: readonly [
    maxSteps: number | null,
    maxToolCalls: number | null,
    maxSubagentCalls: number | null,
    maxParallelSubagents: number | null,
    maxDepth: number | null,
  ],
  memory: readonly [
    capabilities: readonly MemoryCapability[],
    embeddingModel: string | null,
    summary: readonly [
      model: string,
      everyTurns: number | null,
      sourceTurns: number | null,
    ] | null,
  ] | null,
  sandbox: SandboxPolicyDigestV1 | null,
  workspace: boolean,
  durable: boolean,
  permissions: AgentPermissionsDigestV1 | null,
  governance: GovernanceManifestDigestV1 | null,
  guardrails: GuardrailManifestDigestV1 | null,
]

type WorkflowTargetPolicyDigestV1 = readonly [
  'workflow',
  id: string,
  agentCalls: readonly [
    maxCalls: number | null,
    maxParallel: number | null,
  ],
  maxDepth: number | null,
  sandbox: SandboxPolicyDigestV1 | null,
  workspace: boolean,
  durable: boolean,
]

type ContextProjectionDigestV1 = readonly [
  'tool-result-pruner',
  maxBytes: number,
  headBytes: number,
  tailBytes: number,
  resolvedMarker: string,
]

type HistoryRetentionDigestV1 = readonly [
  maxTurns: number | null,
  maxBytes: number | null,
]

type RuntimeRequirementsDigestV1 = readonly [
  models: readonly (readonly [
    alias: string,
    capabilities: readonly ModelCapability[],
  ])[],
  mcpServers: readonly string[],
  skillRuntimes: readonly SkillRuntimeId[],
  durableStorage: boolean,
  memoryCapabilities: readonly MemoryCapability[],
  memoryModelAliases: readonly string[],
  sandboxCapabilities: readonly SandboxCapabilityId[],
  requiredSandboxGroups: readonly string[],
  sandboxRequired: boolean,
  workspace: boolean,
  artifacts: boolean,
  hostTools: readonly string[],
  hostCheckpointSchema: 'host-nested-target-checkpoint.v1' | null,
]

type GraphDigestPreimageV1 = readonly [
  'harness.graph.v1',
  harnessName: string,
  defaults: readonly [
    maxSteps: number,
    maxToolCalls: number,
    maxSubagentCalls: number,
    maxParallelSubagents: number,
    maxWorkflowAgentCalls: number,
    maxParallelWorkflowAgentCalls: number,
    maxDepth: number,
    runTimeoutMs: number,
    modelTimeoutMs: number,
    toolTimeoutMs: number,
    skillTimeoutMs: number,
    decisionTimeoutMs: number,
    maxParallelToolCalls: number,
    historyWindow: number | null,
    contextProjection: ContextProjectionDigestV1 | null,
    historyRetention: HistoryRetentionDigestV1 | null,
  ],
  requirements: RuntimeRequirementsDigestV1,
  definitions: readonly GraphDefinitionDigestV1[],
  edges: readonly GraphEdgeDigestV1[],
  targetPolicies: readonly (
    | AgentTargetPolicyDigestV1
    | WorkflowTargetPolicyDigestV1
  )[],
  bindings: readonly (readonly [
    agentId: string,
    modelFacingId: string,
    bindingContractDigest: string,
  ])[],
]

type SessionIdentityDigestPreimageV1 = readonly [
  'harness.session-identity.v1',
  tenantId: string | null,
  principalId: string | null,
]
```

`requirements` is exactly `RuntimeRequirementsDigestV1`.
`requiredSandboxGroups` is the same graph-owned requirement set as
`RuntimeRequirements.sandbox.requiredGroups`, and
`sandboxRequired` is the same derived literal value at runtime. Every set-like
array is deduplicated and bytewise lexicographically sorted; model rows sort by
alias.
A context projection with no `toolResultPruner` normalizes to `null`; otherwise
its marker is resolved to the existing default before encoding. History
retention encodes each absent bound as `null`.

`definitions` sorts by canonical tuple bytes. MCP tools include their owner id,
so equal local ids on different servers remain distinct. `edges` contains every
selected explicit tool, Skill, MCP owner/tool, model, subagent, and workflow
target reference using only the relation-discriminated `GraphEdgeDigestV1`;
there is no independent or optional local-key field. Guardrail references and
generated agent bindings are represented in their exact target/binding
manifests. Edges sort by canonical tuple bytes. `bindings` sorts by agent id then
model-facing id.

`targetPolicies` uses only `AgentTargetPolicyDigestV1` and
`WorkflowTargetPolicyDigestV1`, sorted by kind then id. Omitted policies use the
shown `null` or `false` values; resolved governance defaults are encoded rather
than omitted. A workflow target encodes its definition-level `agentCalls`
overrides as `[maxCalls|null,maxParallel|null]` immediately after its id. The
graph `defaults` tuple encodes resolved `maxWorkflowAgentCalls` and
`maxParallelWorkflowAgentCalls` immediately after `maxParallelSubagents` and
before `maxDepth`. Overrides never move into `RuntimeRequirementsDigestV1`.
Tool-key selectors, external declared effects, phase names,
capabilities, and runtimes are set-like and bytewise lexicographically sorted.
Permission pattern arrays, native policies/rules, external policies, and
exposure rules preserve declaration order because it may affect decisions and
evidence. `hasPredicate` and `hasAuditSink` record executable-boundary presence;
their function bodies remain covered by `deploymentRevision`. Every absent
optional tuple value is `null`, never omitted.

`compiledGraphDigest` hashes `GraphDigestPreimageV1`. It excludes functions,
arbitrary Standard Schema validators, prompts, secrets, providers, and live
adapters; `deploymentRevision` covers those application-controlled semantics.
`sessionIdentityDigest` hashes `SessionIdentityDigestPreimageV1` after
`normalizeHarnessIdentity`; an absent identity hashes the two `null` values.
H4-008 owns this final graph-preimage assembly and rejects a mismatch before any
handler or model call. Its graph-digest tests independently change each workflow
override and each resolved workflow default, prove the digest changes, and prove
otherwise equal definitions/configurations remain stable with the exact tuple
order above.

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
| hosted runtime configuration | `HostedHarnessInstanceConfig` | validated shared runtime bindings plus host-owned bindings | a second hosted runtime or caller-supplied logger/telemetry |
| host invocation context | opaque `HostInvocation` projected into one call-scoped handler closure | identity, trace context, and `HostContext` | checkpoint, session, registry, log, model, or inspection storage |
| host nested target result | `RunCheckpoint.output` containing `HostNestedTargetCheckpointV1` | replayed `nestedTargets.run` result under the root lease | reuse of `WorkflowChildCallCheckpoint`, another storage API, or direct child output as host-tool output |
| host ownership | factory-authentic `HostOwnerToken` in hidden definition metadata | exact identity comparison at hosted instantiation | id/digest inference, public metadata, serialization, or persistence |

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

H4-009 specifically proves: exact hosted config inference, including forbidden
logger, telemetry, and caller trace fields; factory-authentic owner matching,
mixed-owner rejection before resource initialization, copied-target rejection,
and no host invocation persistence or registry exposure; identity and trace
projection exactly once per entry and again with the fresh invocation on
resume, with deterministic validation order and sanitized projector failures;
root, workflow, subagent, and host nested target dispatch through the host
dispatcher while portable and host tools share the common policy, approval,
validation, event, timeout, cancellation, and telemetry pipeline; conservative
durable-storage and revision requirements for every host-aware graph; exact
host-call and host-step checkpoint keys, schemas, replay, equal-call
coalescing, target-before-input conflicts, terminal failure/cancellation replay,
and rejection of distinct concurrent nested calls; agent-to-host-to-agent and
agent-to-host-to-workflow interruption trees that resume leaf first, re-enter
the host handler with a fresh overlay, repeat no managed effect, emit no second
`tool.started`, and use the re-entered handler return as the tool output; and
transactional startup/close behavior that never closes borrowed host resources.

H4-003 specifically proves the spec 36 `ACC-SOWN-POLICY` boundary introduced by
the v4 compiler and instance-config projection: graph agent/workflow policies
and workflow child-task declarations contribute their exact literal required
group union and set `sandbox.required`; catalog composition preserves that
union; the composition-owned configured groups infer only from `groups` as a
const tuple; every required group must be configured; and
`defaultPolicy.group` accepts only a configured group. Missing required groups,
unknown default or child-task groups, duplicate groups, and malformed group ids
fail deterministically. Negative cases cover both an unknown default with no
`groups` field and a typo beside a valid configured tuple;
and negative type tests forbid `sandbox`, `sandboxBinding`, and session
`sandboxOwner` for a sandbox-free graph while requiring the exact sandbox
binding for every sandbox-required graph.

H4-008 specifically proves: exact definition-keyed instance/session/invoker
inference and negative unknown-key/config cases; aggregate/stream terminal
parity; positive contiguous event sequences, deterministic ids, exact append
retry, and conflict/gap rejection; terminal events that survive live overflow;
exact strict content-free `PersistedRunFinishedPayload` projections for
completed, interrupted, failed, and cancelled outcomes; no persisted terminal
output or interrupt content; `PersistedFinalRunEvent` status/error mapping and
atomic finalization coherence without a duplicate output; terminal replay that
reconstructs the typed public event from its validated envelope and terminal
`RunRecord` without another append or an unsafe payload cast;
strict `CreateRunRequest` for agent, workflow, and child-task records;
storage-authored revision-one running state; recursively frozen authoritative
returns; exact creation retry after later state changes; deterministic
content-free conflict precedence; and durable same-run-id input mismatch before
acquisition;
the original persisted `run.started` as the first approval-resume stream item
without another append, broadcast, id, or sequence allocation;
one agent start and one eventual finish across process restart; one
`model.completed` carrying the loop-supplied stream id; strict approval
validation precedence, equal-event coalescing, changed-event conflict, fenced
checkpoint progression, and atomic terminal checkpoint deletion; one resumed
provider request or stream that commits a strict correlated
`AcceptedModelTurnCursorV1` before `afterModel`, removes the consumed
ProviderContinuation, retains only a newly returned validated continuation,
and never repeats that provider turn after cursor commit; an exact cursor-CAS,
deterministic `model.completed`, `afterModel`, continue-CAS order with one event
sequence advance; restart from `after_model` with idempotent event replay and
the documented callback window, and restart from `continue_turn` without
repeating the provider, event, or Guardrail; exact
whole-batch tool/subagent budget accounting; completed sibling transcript
deduplication; and suspended-child completion through output validation,
`afterTool`, and one `tool.finished` without another invocation or
`tool.started`; a strict terminal approval receipt that replays the same
event/decisions after restart, rejects changed same-event decisions, and marks
a new event stale; a second sequential interruption whose pending checkpoint
replays exactly its immediately consumed prior event and treats older events as
stale; complete receipt revision/graph/session/root context plus required
authoritative `RunRecord.input`; canonical pre-transform input comparison using a deliberately
transforming input schema whose transform runs only on the initial invocation;
nondestructive optimistic validation followed by lease CAS and exact
record/checkpoint byte revalidation, including initial/resume acquisition,
stale revision or checkpoint rejection, exact pre-effect acquisition retry,
competing lease, expiry takeover, stale release, and lease-release failure
precedence;
nested leaf-first resume with completed siblings and
workflow `WorkflowAgentCallBudgetStateV1` preserved; startup rollback after
each initialization stage, including simultaneous initializer and reverse-order
cleanup failures with the exact aggregate; durable-by-definition agent and
workflow calls, generated durable defaults, and approval-recovery lease
acquire/interrupt/reacquire/finalize behavior; the spec 33
`inMemoryMemoryEngine()` default with no sandbox-memory path; concurrent
idempotent close and identity-deduplicated ownership; session release/destroy
and child-task cancellation; owner-only `SessionChildTasks` lookup for resident,
terminal persisted, foreign-session, and non-resident running records, including
the frozen non-resident recovery handle's content-free status and exact local
`recovery_required` failures without task effects; and graph
digest stability plus independent sensitivity to both workflow overrides and
both resolved workflow defaults. Compiler tests prove the immutable recursive
permission/governance-only approval inventory for agent and workflow roots,
proves a Guardrail durable requirement does not set approval reachability, and
proves requirements, child-task preflight, and session lease selection consume
the exact `graph.approval.agents/workflows[id].reachable` rows without a second
definition traversal. The storage contract suite runs these atomic
operations against in-memory and SQLite implementations.

H4-008 also proves the spec 36 `ACC-SOWN-OWNER` and `ACC-SOWN-DURABLE` behavior
at the v4 runtime boundary: session owner registration allocates no compute;
partition selection uses the explicitly configured group set, definition or
child-task override, and default policy with spec 36 precedence; a missing
`authorizeOwner`, tenant or principal scope mismatch,
callback denial, and callback throw all fail before admission or effects;
authorization is repeated for every top-level invocation, child launch, and
resumed execution; terminal replay performs no sandbox compute open; and
independently changing the required group set, configured group set, default
policy, agent/workflow sandbox policy, or child-task override changes the
durable partition-policy digest. Erased-type attempts to
supply a sandbox owner to a sandbox-free graph fail before a session write.

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
