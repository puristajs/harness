# Tools and MCP

**Status:** active v4 topic contract.

[Spec 42 §3](./42-composable-definitions-and-catalogs.md) owns exact definition,
inference, binding, and lifecycle types. The prepared-tool contract in
[spec 37](./37-decision-boundaries/03-contracts/decisions.md) owns execution
ordering.

## Portable native tools

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

`defineTool` returns a frozen definition with exact `$infer.input`,
`$infer.validatedInput`, and `$infer.output` types. The input must implement
Standard JSON Schema V1 because it is presented to a model. Input and output
validation follows the Standard Schema boundary in [spec 39](./39-standard-schema-boundaries/00-vision.md).

A tool can declare memory or sandbox requirements. Only declared capabilities
appear as non-optional typed handler context and contribute to graph runtime
requirements. The handler also receives cancellation, identity, correlation,
idempotency, logger, metrics, and telemetry values owned by the current call.

Portable tool definitions contain no service resources or framework message
context. A host framework provides those capabilities through its own
host-aware tool factory.

## Host-aware tools

A host-aware tool has the same model-facing id, description, input, output, and
inference contract as a portable tool. Its handler context and authentic owner
brand come from the host integrator. An agent lists portable and host-aware
definitions in the same `tools` array and cannot branch on their
implementation kind.

The ordinary standalone entry point rejects a graph containing host-aware
tools. The matching host integrator creates a fresh call-scoped handler
binding, projects authenticated identity and trace data, and executes it
through the common tool pipeline. Host context is never stored in a Harness
definition, instance index, checkpoint, event, or inspection.

## Built-in tools

Harness exports immutable built-in definitions through `builtInTools`:

| Tool | Capability | Default permission |
| --- | --- | --- |
| `read` | `sandbox.fs` | `allow` |
| `glob` | `sandbox.fs` | `allow` |
| `grep` | `sandbox.text_search` | `allow` |
| `list` | `sandbox.fs` | `allow` |
| `write` | `sandbox.fs` | `require_approval` |
| `edit` | `sandbox.fs` | `require_approval` |
| `bash` | `sandbox.exec` | `require_approval` |

Agents select built-ins through direct references:

```ts
const analyst = defineAgent('analyst', {
  instructions: 'Inspect the supplied workspace and report evidence.',
  tools: [builtInTools.read, builtInTools.glob, builtInTools.grep],
})
```

Selection contributes the exact sandbox capability. Permission can further
restrict or require approval for a selected tool; it cannot select the tool or
grant the sandbox capability. Legacy alias spellings are not accepted.

The file tools enforce normalized POSIX paths, sandbox-root containment, byte
limits, cancellation, and content-free errors. `grep` uses the Sandbox
bounded text-search contract. `bash` is exposed only through an exec-capable
sandbox. No built-in falls back to direct host filesystem or process access.

## MCP definitions

`defineMcpServer` declares one server and an explicit typed remote-tool
surface:

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

const assistant = defineAgent('assistant', {
  instructions: 'Answer with evidence from approved knowledge.',
  tools: [knowledgeMcp.tools.searchKnowledge],
})
```

The local object key is the model-facing tool id. `remoteName` is the exact
upstream name. Runtime discovery verifies that each declared tool exists and
that its provider-facing input schema equals the declared normalized schema.
Undeclared remote tools are ignored and never become callable.

Definitions contain no transport or secret. `getInstance` binds each required
server through exactly one of:

```ts
type McpBinding =
  | {
      transport: 'http'
      url: string
      headers?: Readonly<Record<string, string>>
      resolveHeaders?: (
        context: McpRequestHeaderContext,
      ) =>
        | Readonly<Record<string, string>>
        | Promise<Readonly<Record<string, string>>>
    }
  | {
      transport: 'stdio'
      command: string
      args?: readonly string[]
      env?: Readonly<Record<string, string>>
      sandbox: SpawnCapableSandbox
    }
```

HTTP credential projection runs after approval and immediately before the
request. It receives bounded identity and correlation data. Headers and
callbacks never enter inspection, events, logs, metrics, telemetry, or
persistence. HTTP redirects are disabled so credentials cannot be forwarded to
another origin. Every first-party HTTP transport MUST support per-call
`resolveHeaders`. A configured callback against a transport that cannot apply
it fails atomic instance validation as
`HarnessConfigError{reason:'invalid_runtime_binding',path:
'mcp.<id>.resolveHeaders'}`; it is never ignored.

Stdio execution requires an explicitly spawn-capable sandbox and a minimal
environment. One client, transport, and process bundle is initialized per
declared server, shared by that server's selected tools, and closed
idempotently by the Harness instance. There is no install command, shell
interpolation, working-directory shortcut, or host-process fallback.

Core supports the current MCP Streamable HTTP and stdio transports selected by
the runtime binding. It does not expose the legacy HTTP+SSE transport or
stateful fallback behavior. MCP SDK loading is isolated to the MCP runtime so
applications without MCP definitions do not initialize it.

## Agent-selected tool pipeline

Every agent-selected native, built-in, MCP, subagent, and host-aware tool
occurrence follows the same ordered boundary:

1. resolve the selected definition from the current agent's immutable
   allowlist;
2. apply input Guardrails and validate the effective wire and parsed inputs;
3. evaluate permissions and governance;
4. return a typed approval interruption when approval is required;
5. invoke once with the shared timeout, cancellation, identity, and
   idempotency context;
6. validate the output and apply output Guardrails;
7. checkpoint and emit content-safe lifecycle events.

Direct workflow tool calls use the same authentic binding, input/output
validation, host overlay, timeout, cancellation, event, telemetry, and managed
checkpoint machinery. They do not borrow any agent's exposure, permissions,
governance, approval, or Guardrails. The workflow handler already selected the
exact imported capability. For a PURISTA host tool, every command, stream,
queue, event, agent, or workflow operation invoked by its handler retains that
operation's ordinary business guard. Authorization for the mounted workflow
root may additionally be enforced by its own PURISTA before guard.

Tool calls from an agent carry
`{kind:'agent',agentId,workflowId?}`; direct calls from a workflow carry
`{kind:'workflow',workflowId}`. Both use the same stable `callId` and exactly
one caller identity. A workflow tool call never invents an agent identity.

A definition being present in a catalog or dependency closure does not grant
access. Only a direct reference in the current agent or workflow definition
creates a callable scoped invoker.

## Skills are not tools

A Skill is guidance and resources. Harness synthesizes the reserved
`read_skill` tool only for an agent that declares Skills. It exposes only
those Skills through an exact scoped reader and defaults to `allow`. The
synthesized tool is private to that agent and is absent from catalogs and
public definition maps.

A script becomes a typed, model-callable operation only when an application
wraps it in `defineTool` or a host-aware tool. Skill metadata alone never
creates a tool.

## Failure and privacy

Unknown or unselected model tool names fail before execution. Invalid input or
output uses `ValidationError`; denied decisions use the decision errors;
unexpected handler failures use `ToolError`; MCP transport/protocol failures
use the MCP error family; cancellation and deadlines use their canonical
operation errors.

Errors and observation data may include stable ids, phases, status, duration,
and bounded provider metadata. They never include credentials, headers,
commands with secret environment values, raw Skill content, raw tool input, or
raw tool output under content-free telemetry.

## Required verification

- definition inference and foreign-definition rejection;
- direct-reference allowlists and collision checks;
- one validation/decision/approval/invocation/output pipeline for every
  implementation kind;
- safe built-in defaults and exact sandbox capabilities;
- workflow-versus-agent caller correlation;
- MCP discovery/schema equality, redirects, credential projection,
  cancellation, process death, startup rollback, and shutdown;
- no secret or content leakage in errors, events, logs, metrics, inspection, or
  persisted records.

## References

- [05 — Sandbox](./05-sandbox.md)
- [08 — Skills](./08-skills.md)
- [09 — agents](./09-agents.md)
- [15 — error catalog](./15-error-catalog.md)
- [37 — decision boundary](./37-decision-boundaries/03-contracts/decisions.md)
- [39 — Standard Schema boundaries](./39-standard-schema-boundaries/00-vision.md)
- [42 — exact tool and MCP contracts](./42-composable-definitions-and-catalogs.md)
