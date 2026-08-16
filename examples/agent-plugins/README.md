# Agent Plugins review and binding

This focused example demonstrates the production boundary for an
already-installed Agent Plugins v1 package:

1. inspect it without executing package code;
2. record and review its SHA-256 digest in application-owned configuration;
3. load only the reviewed digest with explicit trust;
4. map chosen Skills and MCP tools to ordinary harness aliases.

Run it against a local package directory:

```bash
npm run build --workspace @purista/agent-plugins-example
npm run start --workspace @purista/agent-plugins-example -- ./path/to/plugin ./path/to/plugin-data
```

The example deliberately does not auto-expose tools, install packages, load
plugin code, or accept plugin-provided credentials. `dataDirectory` is only
needed when binding a selected stdio server. Use the returned `bindings.skills`
and `bindings.tools` in your application's normal `defineHarness()` call.
