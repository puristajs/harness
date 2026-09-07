# Adapters

Adapters implement public ports and report immutable capability metadata. Validate configuration before I/O, propagate `AbortSignal`, map failures to stable content-free Harness errors, and make cleanup idempotent.

Provider adapters translate typed model operations. Memory adapters store scoped recall. Harness storage owns sessions and durable execution. Sandbox adapters isolate file and process capabilities. Workspace adapters persist recoverable files. Telemetry and logger bindings remain safe operational surfaces.

Agent Plugins are data-only packages. Inspect and pin a trusted digest, then select only reviewed Skills and MCP tools:

```ts
const [plugin] = await loadAgentPlugins({ plugins: [{ root, trust: 'trusted', expectedDigest }] })
const selected = await plugin.bindings({
  skills: { playbook: { runtimes: [] } },
  mcpServers: { docs: { server: 'docs', tools: { searchDocs: remoteSearchDefinition } } },
})
```

Compose `selected.skills` and `selected.mcpServers.*.tools` as definitions and pass `selected.mcp` to `getInstance`. Plugins never load code, credentials, installers, or implicit tools.
