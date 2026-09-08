# Guardrail authoring

Guardrails have one TypeScript-first authoring surface. Define actions with
`defineGuardrailAction(...)`, bind their literal phase IDs in the inline
`defineGuardrails({ config, actions })` call, then attach the compiled rails to
an agent definition or an explicit retrieval boundary.

- Configuration is an inline, strict Zod-backed object.
- Model-backed actions name a declared Harness model alias directly. Tool
  actions select their exact tool IDs and sensitive-data actions supply an
  explicit schema-bound codec.
- Native TypeScript tools are created with `defineTool('lookup', { ... })` and
  attached to an agent by direct reference. MCP tools are selected from a
  `defineMcpServer(...)` result in the same way.
- Harness definition compilation aggregates attached requirements, and
  `getInstance(...)` fails before invocation when a
  selected model, capability, or tool is unavailable. Guardrail decisions use
  `allow`, `block`, or a phase-specific `transform`; `reasonCode` remains safe
  for metrics and logs.
