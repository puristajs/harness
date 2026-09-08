# @purista/harness-agent-plugins

First-party, opt-in [Agent Plugins v1](https://agent-plugins.org/specification)
package inspection and definition projection for `@purista/harness`.

The package reads an already-installed local plugin, validates its data files,
calculates a review digest, and projects explicitly selected Skills and HTTP MCP
servers into authentic Harness definitions. It does not import plugin code,
download packages, discover a marketplace, execute tools, connect to MCP, or
accept package-provided credentials.

## Install

```bash
npm install @purista/harness @purista/harness-agent-plugins zod
```

## Inspect, trust, and select

```ts
import { defineAgent, defineHarness } from '@purista/harness'
import { inspectAgentPlugin, loadAgentPlugins } from '@purista/harness-agent-plugins'
import { z } from 'zod'

const source = { root: './plugins/research' } as const
const inspection = await inspectAgentPlugin(source)
if (!inspection.valid || !inspection.digest) throw new Error('Plugin is invalid')

// Store this digest in application-owned reviewed configuration.
const [plugin] = await loadAgentPlugins({
  plugins: [{ ...source, trust: 'trusted', expectedDigest: inspection.digest }],
})

const bindings = plugin.bindings({
  skills: {
    playbook: { runtimes: [] },
  },
  mcpServers: {
    pluginDocs: {
      server: 'docs',
      tools: {
        searchPluginDocs: {
          remoteName: 'search',
          description: 'Search the reviewed plugin documentation.',
          input: z.object({ query: z.string() }),
          output: z.object({ matches: z.array(z.string()) }),
        },
      },
      headers: { 'x-tenant': 'application-owned-value' },
      resolveHeaders: async ({ identity }) => ({
        authorization: `Bearer ${await credentials.forTenant(identity?.tenantId)}`,
      }),
    },
  },
})

const researcher = defineAgent('researcher', {
  instructions: 'Use approved research resources when relevant.',
  skills: [bindings.skills.playbook],
  tools: [bindings.mcpServers.pluginDocs.tools.searchPluginDocs],
})

const instance = await defineHarness({ name: 'pluginApp' })
  .addAgent(researcher)
  .getInstance({
    model: { provider, model: 'gpt-5-mini' },
    mcp: bindings.mcp,
  })
```

`bindings.skills` and `bindings.mcpServers` are package-owned definitions.
`bindings.mcp` contains the runtime HTTP transports. A selected server's
`resolveHeaders` callback is the Core HTTP MCP callback and is preserved by
identity for per-invocation credential projection. `bindings.provenance`
contains content-free plugin name, version, and digest data for review records.

## Security boundary

- Plugins are untrusted until `trust: 'trusted'` and an exact
  application-reviewed `expectedDigest` are both supplied.
- Every path is realpath-contained beneath the plugin root, including symlinks
  and fixed component paths.
- Public diagnostics omit absolute paths, file contents, commands, arguments,
  URLs, headers, environment values, and credentials.
- Skills and MCP tools are never auto-exposed; the application selects each
  component and gives it a typed local ID.
- Package-declared HTTP headers are validated but never sent. Applications bind
  their own static headers, and redirects are rejected.
- Stdio declarations can be inspected, but this projection intentionally does
  not make them selectable or executable. Bind reviewed stdio MCP servers
  directly through Core when the application also supplies a spawn-capable
  sandbox.

Core remains responsible for skill mounting, MCP execution, governance,
approvals, cancellation, timeouts, sessions, lifecycle, and telemetry. Agent
Plugins remain package data rather than executable extensions.
