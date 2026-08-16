# MCP Tools

MCP tools let agents call capabilities exposed by Model Context Protocol
servers. The harness supports two transport modes.

| Mode | Use When | Execution Boundary |
|---|---|---|
| `mcp_stdio` | The MCP server is a local command. | Persistent process via a spawn-capable `SandboxSession`. |
| `mcp_http` | The MCP server is already running remotely or sidecar-local over HTTP. | Uses HTTP; no local process launch. |

## Transport Decision

```mermaid
flowchart TD
  Need["Need MCP tool"] --> Local{"Server is a local command?"}
  Local -- "Yes" --> Spawn{"Sandbox has spawn?"}
  Spawn -- "Yes" --> Stdio["mcp_stdio"]
  Spawn -- "No" --> NoExec["Use a spawn-capable sandbox or mcp_http"]
  Local -- "No" --> Http["mcp_http"]
```

## Stdio Runs In The Sandbox

`mcp_stdio` runs inside the active sandbox session — never spawned directly from
the host process. This keeps filesystem, network, timeout, cancellation,
logging, and tracing policy aligned with the rest of the harness. The transport
requires a spawn-capable sandbox:

- **Persistent transport** — the session advertises `sandbox.spawn`
  (isolation backends such as Docker/e2b/microvm), the server is spawned **once**
  and the MCP `initialize` handshake runs a single time. Every subsequent
  `tools/list`/`tools/call` is multiplexed over the same long-lived pipe, so
  **server-side session state is preserved across calls**. The process is killed
  when the runner (or sandbox session) closes. If the process dies mid-call, the
  call fails with `McpProtocolError{phase:'call'}` and the next call re-spawns and
  re-initializes a fresh server.
There is no exec-only fallback. A sandbox that cannot spawn fails with
`SandboxNoExecutorError`.

## Installing A Stdio MCP Server

Use `install` to bootstrap the MCP server inside the sandbox before first use:

```ts
.tools({
  drawio_diagram: {
    kind: 'mcp_stdio',
    description: 'Create draw.io diagrams from structured architecture notes.',
    install: {
      command: 'npm install @drawio/mcp',
      cwd: '/workspace',
      timeoutMs: 120_000
    },
    command: 'npx',
    args: ['@drawio/mcp'],
    tool: 'drawio.create'
  }
})
```

Lifecycle:

```mermaid
sequenceDiagram
  participant Agent
  participant Harness
  participant Sandbox
  participant MCP

  Agent->>Harness: call drawio_diagram
  Harness->>Sandbox: install.command (first use)
  Harness->>Sandbox: command + args with JSON-RPC stdin
  Sandbox->>MCP: start stdio server
  MCP-->>Sandbox: tools/list + tool result
  Sandbox-->>Harness: stdout/stderr/exit
  Harness-->>Agent: normalized JSON output
```

## HTTP MCP

Use `mcp_http` when the MCP server is already available over streamable HTTP:

```ts
.tools({
  drawio_remote: {
    kind: 'mcp_http',
    description: 'Create draw.io diagrams through a remote MCP server.',
    url: process.env.DRAWIO_MCP_URL!,
    auth: { kind: 'bearer', token: process.env.DRAWIO_MCP_TOKEN! },
    tool: 'drawio.create'
  }
})
```

Supported auth:

- `none`
- `bearer`
- `oauth2`
- `api_key`
- `basic`

## Validation And Errors

The harness calls `tools/list`, validates MCP input/output JSON Schema, and
normalizes MCP response envelopes before returning output to the model.

| Failure | Error |
|---|---|
| Sandbox has no executor for stdio | `SandboxNoExecutorError` |
| Unknown upstream MCP tool | `ToolNotFoundError` |
| Invalid MCP input/output | `ValidationError` |
| MCP protocol/list/call failure | `McpProtocolError` |
| HTTP auth failure | `McpAuthError` |
| MCP tool returns `isError: true` | `ToolError` |

## Living Wiki draw.io Example

The Living Wiki app runs without draw.io MCP by default. To enable a real server:

```env
LIVING_WIKI_DRAWIO_MCP_INSTALL=npm install @drawio/mcp
LIVING_WIKI_DRAWIO_MCP_COMMAND=npx
LIVING_WIKI_DRAWIO_MCP_ARGS=@drawio/mcp
LIVING_WIKI_DRAWIO_MCP_TOOL=drawio.create
```

Or use HTTP:

```env
LIVING_WIKI_DRAWIO_MCP_URL=https://example.test/mcp
LIVING_WIKI_DRAWIO_MCP_AUTH_TOKEN=...
```
