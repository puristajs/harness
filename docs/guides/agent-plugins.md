# Agent Plugins

`@purista/harness-agent-plugins` is the first-party, opt-in client for Agent
Plugins v1 packages. It is intentionally a package-data loader, not an
executable plugin system. `defineCatalog(...)` remains the typed mechanism for
reusable trusted application definitions.

The loader validates a plugin root, manifest, immediate child skills, and
supported MCP declarations locally. It realpath-checks every discovered path,
does not fetch schemas, run package code, or accept package-provided secrets.
Malformed plugin manifests fail closed; individual skills and MCP entries are
reported independently.

An application supplies trust and source identity, inspects the result, and
uses explicit bindings for each intended skill/tool. Existing harness policy,
agent allowlists, sandbox, telemetry, and tool validation still apply.
Every load also supplies an application-reviewed SHA-256 digest; there is no
digest-free trusted-loading mode. Package-declared HTTP headers are validated
but never sent. Applications bind static headers explicitly and may supply
Core's `resolveHeaders` callback for per-invocation credentials. The callback
is preserved directly in the selected HTTP binding, runs only for tool calls
after approval, and never participates in startup discovery. Plugin HTTP
redirects are rejected.

Agent Plugins may provide Skills and modern MCP declarations only. They cannot add
agents, workflows, model providers, hooks, credentials, sandbox authority, or
runtime code. The current package projection selects Streamable HTTP servers.
Stdio declarations can be inspected but are rejected during selection; bind a
reviewed stdio server directly through Core with a spawn-capable sandbox. The
package projection supports Streamable HTTP only.

See [MCP tools](./mcp-tools.md) for current transport setup and requirements.
