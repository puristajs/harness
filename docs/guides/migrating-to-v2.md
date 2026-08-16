# Migrating To AI Harness 2.0

AI Harness 2.0 is a clean breaking release. Upgrade application code and
dependencies together; the runtime contains no legacy compatibility behavior.

## MCP

Replace the retired v1 SDK package with the v2 client:

```bash
npm uninstall @modelcontextprotocol/sdk
npm install @modelcontextprotocol/client@^2
```

The harness pins MCP `2026-07-28`. Update every connected server to its modern
stdio or stateless Streamable HTTP endpoint. Legacy stateful MCP, HTTP+SSE, and
exec-only stdio execution are unsupported.

`mcp_stdio` now requires a sandbox implementation that provides
`SandboxSession.spawn`. If your previous sandbox only supplied `exec`, either
add a spawn-capable sandbox adapter or run the server over modern HTTP. The
stdio process stays inside the sandbox and persists for the runner lifetime.

## Package Versions

Upgrade core and every first-party adapter together to `^2.0.0`. Third-party
adapter authors should change their peer range to `@purista/harness@^2.0.0` and
re-run the public type and contract suites.

## Agent Plugins

Agent Plugins are an opt-in package:

```bash
npm install @purista/harness-agent-plugins@^2
```

They load data-only Agent Plugins v1 manifests, Skills, and approved MCP server
declarations. They never execute package code or automatically expose tools.
Review a package through the application's trust policy, then bind its selected
skills and MCP tools explicitly to the ordinary typed harness builder.

See the [Agent Plugins guide](./agent-plugins.md) and the updated
[AI Harness skill](../../skills/ai-harness/SKILL.md) for the complete setup.
