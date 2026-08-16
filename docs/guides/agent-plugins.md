# Agent Plugins

`@purista/harness-agent-plugins` is the first-party, opt-in client for Agent
Plugins v1 packages. It is intentionally a package-data loader, not an
executable plugin system. Static harness modules remain the typed mechanism for
trusted application code.

The loader validates a plugin root, manifest, immediate child skills, and
supported MCP declarations locally. It realpath-checks every discovered path,
does not fetch schemas, run package code, or accept package-provided secrets.
Malformed plugin manifests fail closed; individual skills and MCP entries are
reported independently.

An application supplies trust and source identity, inspects the result, and
uses explicit bindings for each intended skill/tool. Existing harness policy,
agent allowlists, sandbox, telemetry, and tool validation still apply.

Agent Plugins may provide Skills and modern MCP servers only. They cannot add
agents, workflows, model providers, hooks, credentials, sandbox authority, or
runtime code. Stdio requires a spawn-capable sandbox; remote MCP uses modern
stateless Streamable HTTP. Legacy stateful MCP and HTTP+SSE are rejected.

For upgrade steps, see [Migrating To AI Harness 2.0](./migrating-to-v2.md).
