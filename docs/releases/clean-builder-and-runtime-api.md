# Clean Builder and Runtime API

The Harness 3 API uses one consistent singular/plural registration vocabulary
for every definition family:

| One definition | Reusable record |
| --- | --- |
| `.model(id, definition)` | `.models(record)` |
| `.tool(id, definition)` | `.tools(record)` |
| `.skill(id, definition)` | `.skills(record)` |
| `.agent(id, definition)` | `.agents(record)` |
| `.workflow(id, definition)` | `.workflows(record)` |

Calls are additive and duplicate ids fail immediately. Use singular methods for
inline definitions. In particular, `.tool(...)` contextually derives its
handler input and output from the adjacent schemas and exposes only sandbox
capabilities already registered on the builder. Use plural methods for
cohesive, pre-typed records; `.tools(...)` can contain native and MCP tools.

Native tools are ordinary objects. There is no tool identity helper,
registration brand, callback wrapper, or separate `defineTool` API.

Runtime invocation and lifecycle names now describe their behavior directly:

- `session.agents.<id>.run(input)` and
  `session.workflows.<id>.run(input)` perform non-streaming work;
- `.stream(input)` remains the streaming form;
- `session.release()` frees live resources while retaining persisted state;
- `session.destroy()` explicitly deletes the session and its persisted state.

Custom agent and workflow handlers both receive `ctx.logger` and
`ctx.telemetry`. Workflow `ctx.log` no longer exists. The root run span is
`harness.session.run`.

This is a clean break. The removed tool-helper, `prompt`, session `close`, and
workflow `log` forms have no aliases or compatibility overloads.
