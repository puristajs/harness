# Agent Plugins review and binding

This focused example demonstrates the production boundary for an
already-installed Agent Plugins v1 package:

1. inspect it without executing package code;
2. record and review its SHA-256 digest in application-owned configuration;
3. load only the reviewed digest with explicit trust;
4. map chosen Skills and MCP servers to ordinary typed Harness definitions.

Run it against the included data-only fixture (it binds an HTTPS MCP declaration
but does not connect to it):

```bash
npm install
npm run build
npm run start -- ./fixtures/knowledge-plugin
```

The example deliberately does not auto-expose tools, install packages, load
plugin code, or accept plugin-provided credentials. It passes the selected
definitions directly to `defineAgent()` and the selected transport map to
`getInstance({ mcp: bindings.mcp })`.

To review your own package, replace the fixture path. The package must contain
the `playbook` Skill and `docs` MCP server used by this focused projection, or
adjust the explicit bindings in `src/index.ts` to match its inspected inventory.
