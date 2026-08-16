# @purista/harness-agent-plugins

First-party, opt-in [Agent Plugins v1](https://agent-plugins.org/specification)
support for `@purista/harness`.

The package reads already-installed local plugin directories, validates the
portable `plugin.json`, Agent Skills, and `mcp.json` format using bundled
schemas, calculates a review digest, and creates explicitly selected core
harness bindings. It never imports plugin code, downloads schemas, connects to
a network endpoint, or discovers a marketplace.

## Install

```bash
npm install @purista/harness @purista/harness-agent-plugins
```

## Review, trust, and bind explicitly

```ts
import { defineHarness } from '@purista/harness'
import { inspectAgentPlugin, loadAgentPlugins } from '@purista/harness-agent-plugins'

const source = { root: './plugins/research' } as const
const inspection = await inspectAgentPlugin(source)

// Persist this digest in your application-owned reviewed lockfile.
if (!inspection.valid || !inspection.digest) throw new Error('Invalid plugin')

const [plugin] = await loadAgentPlugins({
  plugins: [{ ...source, trust: 'trusted', expectedDigest: inspection.digest }]
})
if (!plugin) throw new Error('Plugin was not trusted or changed after review')

const bindings = plugin.bindings({
  // Local aliases remain literal, typed harness ids.
  skills: { research_playbook: 'research-playbook' },
  tools: {
    search_docs: {
      server: 'knowledge',
      tool: 'search',
      description: 'Search approved knowledge sources.'
    }
  }
})

if (bindings.diagnostics.some((item) => item.level === 'error')) {
  throw new Error('Invalid selected plugin binding')
}

const harness = defineHarness()
  .skills(bindings.skills)
  .tools(bindings.tools)
  .agents(({ agent }) => ({
    researcher: agent({
      model: 'primary',
      skills: ['research_playbook'],
      tools: ['search_docs'],
      instructions: 'Use the approved research resources when relevant.'
    })
  }))
  .build()
```

## Security and DX

- Plugins are untrusted by default. `trust: 'trusted'` or `trustedRoots` is
  required before `loadAgentPlugins()` returns a loadable plugin. Loading also
  requires an application-reviewed SHA-256 `expectedDigest`; there is no
  digest-free trusted-loading mode.
- The deterministic digest is intended for an application-owned review/lockfile
  workflow. A malformed or mismatched digest returns no loadable entry.
- Every package read is `realpath`-contained within the plugin root, including
  symlinks, junctions, and fixed component paths. Public diagnostics and
  inspections deliberately omit absolute paths, file contents, commands,
  arguments, URLs, headers, environment values, and credentials.
- Skills and tools are never auto-exposed. Callers select source components and
  assign normal local aliases, preserving the harness’s typed agent allowlists.
- Reviewed stdio plugins additionally require an existing caller-owned
  `dataDirectory` whose resolved path does not overlap the plugin root. At
  launch the package serializes access to that data directory, stages normal
  package files and persistent data under a deterministic sandbox path, then
  synchronizes only the staged data back on runner shutdown; plugin code never
  receives the host path.
- The package validates stdio and Streamable HTTP declarations. Legacy HTTP+SSE
  is intentionally unsupported in this clean-major MCP integration.
- A selected stdio server additionally requires that caller-owned data
  directory. Its trusted package and persistent data are staged into the
  current spawn-capable sandbox; package code is never evaluated and data is
  synchronized only to that caller-owned directory when the runner closes.
- Plugin HTTP headers are public static configuration only. Credential-bearing,
  hop-by-hop, and MCP protocol headers are rejected case-insensitively;
  application-owned authentication and protocol headers are supplied by core.

The core harness remains responsible for skill mounting, MCP tool execution,
governance, approvals, cancellation, timeouts, sessions, shutdown, and
OpenTelemetry. Agent Plugins are package data, never `HarnessModule`s or
executable extensions.
