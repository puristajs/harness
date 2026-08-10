# Architecture

The harness is an in-process TypeScript runtime. It sits between your
application and external model providers, tools, state, sandbox execution, and
telemetry.

## Mental Model

```mermaid
flowchart TB
  subgraph App["Application boundary"]
    UI["UI / API route / worker"]
  end

  subgraph Harness["@purista/harness"]
    Builder["defineHarness builder"]
    Session["Session"]
    Agent["Agent loop: LLM conversation + tools"]
    Workflow["Workflow handler: orchestration"]
    Events["Run events"]
  end

  subgraph Adapters["Infrastructure adapters"]
    Model["ModelProvider"]
    State["StateStore"]
    Sandbox["SandboxSession"]
    Workspace["DurableWorkspaceStore"]
    Telemetry["Logger + OTel"]
  end

  subgraph Capabilities["Agent capabilities"]
    Builtin["Built-in tools"]
    TsTool["TypeScript tools"]
    Mcp["MCP tools"]
    Skills["Skills"]
  end

  UI --> Session
  Builder --> Session
  Session --> Agent
  Session --> Workflow
  Workflow --> Agent
  Agent --> Model
  Agent --> Builtin
  Agent --> TsTool
  Agent --> Mcp
  Agent --> Skills
  Builtin --> Sandbox
  TsTool --> Sandbox
  Mcp --> Sandbox
  Session --> State
  Session --> Workspace
  Session --> Events
  Events --> Telemetry
```

## Core Concepts

| Concept | What It Does | User Decision |
|---|---|---|
| `Harness` | Compiled definition of models, tools, skills, agents, workflows, defaults, and adapters. | What capabilities exist? |
| `Session` | Isolated operational context with memory, history, sandbox, and one active run at a time. | What user/thread/tenant is this run for? |
| `Agent` | A typed LLM conversation loop. It prepares messages, calls the model, executes tool invocations, appends tool results, repeats until the model returns, validates output, and emits events. | What single model-driven job should this loop perform? |
| `Workflow` | Application-owned orchestration around one or more agent invocations. It can sequence, branch, fan out, reflect, judge, request human approval, and perform durable writes. | What business process or multi-step flow must happen around agents? |
| `Tool` | Callable capability exposed to an agent: built-in, TypeScript, or MCP. | What can the agent do besides model calls? |
| `Skill` | Mounted instruction directory with `SKILL.md` frontmatter. | What reusable method or domain guidance should the agent follow? |
| `Sandbox` | Filesystem and optional command execution boundary. | Can this run execute commands, and with what isolation? |
| `DurableWorkspaceStore` | Production replay boundary that links runtime checkpoints to persisted workspace state. | Must this run resume from committed workspace state after retry or restart? |

## Agents Versus Workflows

```mermaid
flowchart TB
  subgraph Agent["Agent"]
    A1["Input schema"]
    A2["Instruction + history"]
    A3["Model call"]
    A4["Tool invocation loop"]
    A5["Output schema"]
    A1 --> A2 --> A3 --> A4 --> A3
    A3 --> A5
  end

  subgraph Workflow["Workflow"]
    W1["Validate request"]
    W2["Invoke agent A"]
    W3["Invoke agent B or run in parallel"]
    W4["Apply policy / review gate"]
    W5["Write artifact or state"]
    W1 --> W2 --> W3 --> W4 --> W5
  end
```

Use an agent when the unit of work is one LLM conversation loop, even if that
loop uses several tools. Use a workflow when the application needs to control
multiple agent invocations, approval steps, deterministic logic, persistence,
or side effects.

## Direct Agent Lifecycle

```mermaid
sequenceDiagram
  participant App
  participant Session
  participant Agent
  participant Model
  participant Tool
  participant State

  App->>Session: session.agents.answerer.stream(input)
  Session->>State: create run
  Session-->>App: run.started
  Session->>Agent: invoke
  Agent->>Model: object request with tool specs
  Model-->>Agent: tool call or final object
  opt tool call
    Agent-->>App: tool.started
    Agent->>Tool: execute with timeout and sandbox
    Tool-->>Agent: validated output
    Agent-->>App: tool.finished
    Agent->>Model: continue with tool result
  end
  Agent-->>Session: validated output
  Session->>State: finish run, append messages
  Session-->>App: run.finished
```

## Workflow Lifecycle

Workflows are not required. Use them when the application needs explicit
orchestration around agents.

```mermaid
flowchart LR
  Input["Validated workflow input"] --> Plan["Workflow handler"]
  Plan --> A1["Agent A"]
  Plan --> A2["Agent B"]
  A1 --> Join["Synthesis / policy / review"]
  A2 --> Join
  Join --> Output["Validated workflow output"]
```

## Event And Trace Shape

Session streaming APIs emit run events. Applications can render these events in
a chat UI, run inspector, logs, or tests. Model stream chunks consumed inside a
workflow or custom agent handler stay internal unless that model stream call
opts in with `{ emitRunEvents: true }`.

```mermaid
flowchart TD
  R1["run.started"] --> A1["agent.started"]
  A1 --> T1["tool.started"]
  T1 --> T2["tool.finished"]
  T2 --> A2["agent.finished"]
  A2 --> R2["run.finished"]
  R1 --> OTel["OpenTelemetry spans"]
  T1 --> OTel
  R2 --> OTel
```

Telemetry emits GenAI and OpenInference attributes by default. Set
`telemetry.flavor` to `gen_ai_only` or `openinference_only` when a backend
expects one namespace. `InvokeOptions.traceparent` and `tracestate` are
extracted before the root run span is created; invalid Trace Context is logged
and the run starts a new trace.

The session, workflow, agent, model, and tool spans form one parent/child trace.
The harness records current GenAI operation-duration metrics for each layer;
failed or aborted operations set `ERROR` and share the same `error.type` on the
span and duration metric, while successful spans retain the OpenTelemetry
default `UNSET` status.

Persisted run events never store prompts, model outputs, tool inputs/results,
memory, files, or user data. They may store operational metadata such as ids,
counts, dimensions, status, serialized errors, and token usage. Telemetry
content capture controls span content only; it does not change StateStore audit
retention.
