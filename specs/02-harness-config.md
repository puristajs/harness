# Harness definition and runtime configuration

**Status:** active v4 topic contract.

[Spec 42](./42-composable-definitions-and-catalogs.md) owns the exact generic
types, validation order, requirement derivation, defaults, and lifecycle. This
file records the configuration model an application uses.

## Define and compose

`defineHarness` is synchronous and returns an immutable Harness definition:

```ts
const supportHarness = defineHarness({
  name: 'support',
}).addAgent(answerQuestion)
```

`name` is required. `revision` is required when the compiled graph can
suspend or resume durable work. `defaults` contains only closed,
content-free execution policy. No live provider or adapter belongs in the
definition.

The only composition operations are:

- `addAgent(agent)`, which exposes that agent as a root;
- `addWorkflow(workflow)`, which exposes that workflow as a root;
- `use(catalog)`, which exposes the agents and workflows explicitly exported
  by that nonempty-root catalog.

Every operation returns another frozen Harness definition. Tools, Skills, MCP
servers, Guardrails, governance, and subagents enter the graph through direct
references from agents or workflows. They are dependencies and do not become
public targets.

## Execution defaults

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
```

Resolved values are:

| Setting | Default |
| --- | ---: |
| `maxSteps` | 16 |
| `maxToolCalls` | 32 |
| `maxSubagentCalls` | 32 |
| `maxParallelSubagents` | 8 |
| `maxWorkflowAgentCalls` | 32 |
| `maxParallelWorkflowAgentCalls` | 8 |
| `maxDepth` | 1 |
| `runTimeoutMs` | 600,000 |
| `modelTimeoutMs` | 300,000 |
| `toolTimeoutMs` | 120,000 |
| `skillTimeoutMs` | 60,000 |
| `decisionTimeoutMs` | 10,000 |
| `maxParallelToolCalls` | 8 |
| `historyWindow` | 32 |
| `historyRetention` | 100 complete turns and 8,388,608 bytes |

`contextProjection` is absent by default. `runTimeoutMs: 0` disables only
the root run timeout and `historyWindow: 0` includes system messages only.
Every other numeric default is a positive safe integer. Agent loop values and
invocation options override only their documented subset.

## Derived runtime requirements

The compiler derives one immutable `RuntimeRequirements` value from the full
definition closure. Authors do not maintain a parallel capability list.
Requirements include:

- exact model aliases and capabilities;
- MCP server ids and Skill runtime ids;
- storage durability;
- memory capabilities and model aliases;
- sandbox capabilities, required ownership groups, and whether a sandbox is
  needed;
- workspace and artifact-store needs;
- host-aware tool ids.

The requirement value is exposed for typed host integration and sanitized
inspection. Runtime assembly consumes it and never walks definitions again to
derive a different answer.

## Create an instance

```ts
const runtime = await supportHarness.getInstance({
  model: {
    provider: openaiProvider,
    model: 'gpt-5.5',
  },
})
```

The `primary` alias always uses singular `model`. Additional or exclusively
non-primary aliases use an exact `models` map:

```ts
const runtime = await knowledgeHarness.getInstance({
  model: {
    provider: openaiProvider,
    model: 'gpt-5.5',
  },
  models: {
    embeddings: {
      provider: openaiProvider,
      model: 'text-embedding-3-large',
    },
  },
  storage,
  memory,
})
```

Callers never repeat model capabilities. The compiler injects them from the
graph requirements after validating provider methods and optional provider
model metadata.

Conditional fields follow these rules:

- `mcp` is required exactly for the graph's MCP server ids.
- `storage` is required for durable graphs and may replace the process-local
  default for other graphs.
- `memory` is required for declared memory needs and may replace the
  process-local default otherwise.
- `sandbox`, `workspace`, and `artifacts` exist only when the graph needs
  them.
- `sandboxBinding` configures explicit sandbox ownership groups when a
  sandbox exists.
- `agentAdmission`, model `admission`, `logger`, and `telemetry` are
  optional deployment controls.
- A graph containing host-aware tools cannot use ordinary standalone
  `getInstance`; the host integrator must instantiate it.

Supplying storage or memory changes the implementation of an already available
facility. It does not grant a target access, mark a target durable, or add a
model alias. Executable infrastructure that the graph does not require is
rejected rather than initialized silently.

## MCP runtime bindings

An MCP definition selects exact remote tools and schemas. Runtime configuration
selects the transport and credentials:

```ts
const runtime = await knowledgeHarness.getInstance({
  model: { provider, model: 'gpt-5.5' },
  mcp: {
    knowledge: {
      transport: 'http',
      url: process.env.KNOWLEDGE_MCP_URL!,
      resolveHeaders: async ({ identity }) => ({
        authorization: await issueScopedToken(identity),
      }),
    },
  },
})
```

HTTP and stdio bindings are the exact discriminated union in
[spec 42 §3.3](./42-composable-definitions-and-catalogs.md). Definition values
never contain a URL, process command, credential, or environment value.

## Validation and lifecycle

Definition factories and composition validate pure authoring facts
synchronously. `getInstance` validates the complete runtime binding
synchronously before it starts asynchronous initialization. Unknown keys,
missing or unexpected bindings, capability mismatches, invalid adapters, and
unsupported standalone host tools produce stable `HarnessConfigError`
reasons and paths.

Initialization is deterministic and transactional. An initializer owns only
what it creates. A later failure closes created resources in reverse order and
preserves all failures. Caller-supplied providers and adapters are borrowed.
Runtime `close()` is concurrent-safe and idempotent.

`inspect()` is synchronous and data-only. It distinguishes roots and
dependencies and reports requirements and sanitized adapter metadata. It
cannot initialize a resource or expose prompts, handlers, credentials, hidden
identity tokens, or callable indexes.

## Sessions

```ts
const session = await runtime.getSession('conversation-1', {
  identity: {
    tenantId: 'tenant-1',
    principalId: 'user-42',
  },
})

const result = await session.agents.answerQuestion.run('How do I reset my PIN?')
await session.release()
```

The agent and workflow maps contain roots only and retain exact input, output,
update, and interruption types. `release` detaches this caller while
`destroy` destructively removes the session under the storage and ownership
contract.

## References

- [42 — exact definition, instance, and invocation types](./42-composable-definitions-and-catalogs.md)
- [06 — model provider contract](./06-models.md)
- [11 — sessions](./11-sessions.md)
- [13 — public API index](./13-public-api.md)
- [32 — Harness storage](./32-harness-storage.md)
