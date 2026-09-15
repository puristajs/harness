# Agents

**Status:** active v4 topic contract.

An agent is a configurable provider-neutral model loop. It owns instructions,
input/output contracts, explicitly selected capabilities, policy, and bounded
loop settings. It has no arbitrary execution handler; custom orchestration
belongs in a workflow.

[Spec 42 §5–§6](./42-composable-definitions-and-catalogs.md) owns the exact
types, inference, graph, execution, subagent, and interruption behavior.

## Minimal definition

```ts
const assistant = defineAgent('assistant', {
  model: 'chat',
  instructions: 'Answer clearly and concisely.',
})
```

The application must select a model alias explicitly. Harness gives `chat` no
special meaning; it is simply the name chosen in this example. Other defaults
are:

- Harness string input and output schemas;
- safe input-to-user-message projection;
- text response with live text deltas;
- bounded loop values inherited from the Harness;
- no tools, Skills, Guardrails, governance, memory, subagents, sandbox,
  workspace, or durability requirement.

The factory validates pure authoring data synchronously and returns a frozen
definition with a frozen `contract` and non-enumerable frozen `$infer`.

## Add capabilities directly

```ts
const transactionAnalyst = defineAgent('transactionAnalyst', {
  description: 'Analyzes one transaction for unusual activity.',
  model: 'fast',
  input: transactionAnalysisInputSchema,
  output: transactionAnalysisOutputSchema,
  instructions: 'Use the supplied facts and return a concise assessment.',
  tools: [getTransaction],
  skills: [transactionAnalysis],
  guardrails: transactionGuardrails,
  subagents: {
    policySpecialist: {
      agent: policySpecialist,
      description: 'Use for questions about transaction policy.',
    },
  },
  loop: {
    maxSteps: 8,
    maxToolCalls: 12,
    maxSubagentCalls: 3,
    maxParallelSubagents: 1,
    maxDepth: 1,
  },
})
```

Tools, Skills, Guardrails, and subagents are definition references. A catalog
can make those values easy to import, but only this explicit selection grants
the agent access.

A subagent shorthand reference is permitted only when the child has a useful
definition description. Otherwise the parent supplies a description that tells
the model when to delegate. The subagent map key becomes the model-facing tool
name and does not have to equal the child agent id.

Agent-to-subagent cycles fail graph compilation. Iteration or reciprocal
coordination belongs in a workflow.

## Input, prompt, and response

The caller supplies the input schema's input type. Harness validates it exactly
once before instructions or model access.

Without `prompt`, a validated string becomes one user text part and another
JSON value becomes its canonical JSON text. A custom pure prompt mapper receives
validated input and returns one or more provider-neutral user messages. It
cannot create system, assistant, or tool history. Vision, audio, or file input
requires an explicit mapper plus the corresponding declared
`inputCapabilities`.

Harness derives response behavior from the output schema:

- an unambiguously string-only output uses text and text-stream provider
  operations and emits `output.text.delta`;
- an unambiguously non-string JSON output uses object and object-stream
  operations and emits `output.object.snapshot`;
- an ambiguous top-level projection requires `responseMode: 'text' |
  'structured'`.

An explicit compatible response mode is legal. An incompatible mode fails
definition compilation. Authors do not configure a separate stream mode or
update kind.

## Selected tools and Skills

The model sees only the explicitly selected tool definitions plus generated
subagent tools and, when Skills are present, the scoped `read_skill` tool.
Names must be unique within that agent.

Built-in safe defaults are:

- `read`, `glob`, `grep`, and `list`: allow inside the authorized
  sandbox scope;
- `bash`, `write`, and `edit`: require approval;
- generated `read_skill`: allow.

Explicit permissions may tighten or deliberately change an occurrence. A
permission never selects a tool or creates an adapter capability. Governance
is defined on the agent and is typed to its complete model-facing tool map.
Business authorization remains outside Harness agent policy when a host such as
PURISTA provides business guards.

## Guardrails

An agent may reference one provider-neutral `AgentGuardrailsBinding`.
Guardrails execute at the phases and with the transforms defined by specs 37
and 38. Their exact tool, model, memory, sandbox, Skill-runtime, durability,
workspace, and artifact requirements flow into the compiled graph. Authors do
not duplicate those requirements manually.

Input and output transforms are reparsed at their schema boundaries. A block or
evaluation failure stops before later side effects. A `beforeOutput`
Guardrail buffers assistant content until the final candidate passes; without
one, provider deltas/snapshots stream provisionally while the loop continues.
Only the validated terminal step becomes `RunOutcome.output` and canonical
assistant history.

## Memory, sandbox, workspace, and durability

`memory` declares an exact agent memory policy and its model aliases.
`sandbox` declares ownership/partition policy. `workspace: true` and
`durable: true` contribute their corresponding runtime requirements.

Any reachable approval path contributes durable storage automatically. The
compiler considers selected built-in permission defaults, explicit
permissions, governance effects, and recursively reachable subagents. A
Guardrail contributes durability only through its explicit requirement.

## Default loop

Each invocation follows one lifecycle:

1. validate input and apply input Guardrails;
2. build instructions and prompt messages with bounded session history;
3. prepare the available model-facing tool map;
4. apply exposure policy and model-request Guardrails;
5. call the selected model and stream its status/output;
6. if tools are requested, execute the prepared batch through the common tool
   pipeline and continue;
7. validate and protect the terminal output;
8. commit history, result, and terminal event.

Loop limits cover steps, total tool calls, subagent calls, parallel subagents,
and depth. Cancellation and the nearest inherited deadline propagate through
models, tools, subagents, storage, sandbox, and event delivery.

## Subagent execution

Subagents execute through the target dispatcher with a fresh child run,
immutable identity, trace propagation, stable call id, parent correlation, and
remaining depth. A PURISTA-hosted dispatcher routes the call through
EventBridge even when parent and child are in the same process.

Nested output and status events are correlated and relayed to the parent
stream. A child approval interruption suspends the root invocation tree and is
resumed leaf-first. It is not converted into a generic tool failure. A
dependency-only subagent does not become a public root.

## Testing expectations

- omitted and structured schemas infer exact input/output/update types;
- incompatible response modes and undeclared media fail before provider I/O;
- only selected direct references become model-callable;
- tool-name and graph-cycle failures are deterministic;
- safe permission defaults and recursive approval requirements are exact;
- prompt mapping, history bounds, stream/aggregate parity, cancellation, and
  output buffering are covered;
- subagent dispatch, lineage, budgets, interruption, durable replay, and host
  routing are covered without direct JavaScript fallback;
- prompts, model content, tool content, credentials, and continuation state
  remain absent from content-free telemetry and persistence.

## References

- [06 — model provider](./06-models.md)
- [07 — tools and MCP](./07-tools.md)
- [08 — Skills](./08-skills.md)
- [11 — sessions](./11-sessions.md)
- [24 — governance](./24-governance-policy.md)
- [37 — decision lifecycle](./37-decision-boundaries/03-contracts/decisions.md)
- [38 — Guardrail authoring](./38-guardrail-authoring/00-vision.md)
- [42 — exact agent and subagent contract](./42-composable-definitions-and-catalogs.md)
