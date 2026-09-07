# Use MCP tools

An MCP server definition describes the tools an agent may see. The transport,
URL, process command, credentials, and sandbox belong to the runtime instance.
Keeping those concerns separate makes the same definitions reusable in local,
test, and production environments.

Install the optional MCP client only in applications that use MCP:

```bash
npm install @purista/harness @modelcontextprotocol/client zod
```

## Declare the server and selected tools

Declare only the remote tools the application needs. Each local key becomes the
stable tool name visible to the agent; `remoteName` is the name advertised by
the MCP server.

```ts
import { defineAgent, defineHarness, defineMcpServer } from '@purista/harness'
import { z } from 'zod'

const knowledge = defineMcpServer('knowledge', {
  tools: {
    search: {
      remoteName: 'search_documents',
      description: 'Search the approved product documentation.',
      input: z.object({ query: z.string().min(1), limit: z.number().int().max(10) }),
      output: z.object({ results: z.array(z.object({ title: z.string(), text: z.string() })) }),
    },
  },
})

const assistant = defineAgent('assistant', {
  instructions: 'Answer from the approved documentation. Use search when needed.',
  tools: [knowledge.tools.search],
})

const supportHarness = defineHarness({ name: 'support' })
  .addMcpServer(knowledge)
  .addAgent(assistant)
```

The direct tool reference prevents misspelled allowlists and makes a foreign or
undeclared MCP tool a definition-time error.

## Bind Streamable HTTP

Use HTTP when the server already runs remotely or beside the application:

```ts
const instance = await supportHarness.getInstance({
  model: { provider, model: 'gpt-5-mini' },
  mcp: {
    knowledge: {
      transport: 'http',
      url: process.env.KNOWLEDGE_MCP_URL!,
      headers: { authorization: `Bearer ${process.env.KNOWLEDGE_MCP_TOKEN!}` },
    },
  },
})
```

Treat the URL and headers as trusted deployment configuration. Never derive
them from a prompt, model result, tenant input, or tool arguments.

## Bind stdio in a sandbox

Use stdio for a local MCP server process. Harness starts the persistent process
through a spawn-capable sandbox session, performs the MCP handshake once, and
reuses the connection until the instance closes.

```ts
const instance = await supportHarness.getInstance({
  model: { provider, model: 'gpt-5-mini' },
  mcp: {
    knowledge: {
      transport: 'stdio',
      command: 'node',
      args: ['/opt/mcp/knowledge-server.mjs'],
      env: { NODE_ENV: 'production' },
      sandbox: spawnCapableSandbox,
    },
  },
})
```

There is no host-process fallback. A stdio binding without `sandbox.spawn`
fails before the first model request.

## Runtime behavior

Before a tool result reaches the model, Harness:

1. calls `tools/list` and confirms the selected remote tool exists;
2. validates model-produced input against the declared input schema;
3. invokes `tools/call` through the configured transport;
4. normalizes the MCP result and validates the declared output schema.

Transport, protocol, schema, timeout, and cancellation failures are normalized
as Harness errors. An MCP response with `isError: true` becomes a `ToolError`.
Close the Harness instance to close HTTP clients and terminate persistent stdio
servers:

```ts
await instance.close()
```

MCP tools then participate in the same permissions, governance, approval,
guardrail, telemetry, cancellation, and loop limits as native tools.
