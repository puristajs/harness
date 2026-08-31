# Guardrail authoring: breaking changes

Guardrails now have one TypeScript-first authoring surface. Define actions with
`defineGuardrailAction(...)`, bind their literal phase IDs in the inline
`defineGuardrails({ config, actions })` call, then attach the compiled rails to
an agent or retrieval boundary before `build()`.

- Configuration is an inline, strict Zod-backed object. There is no Guardrails
  configuration file, loader, parser, generated configuration artifact, or
  configuration command.
- Model-backed actions name a registered Harness model alias directly. Tool
  actions select their exact tool IDs and sensitive-data actions supply an
  explicit schema-bound codec.
- Native TypeScript tools are ordinary definitions registered with
  `.tool('lookup', { ... })`; bulk `.tools({ ... })` also accepts reusable
  native definitions and MCP definitions without branding.
- `build()` aggregates attached requirements and fails before invocation when a
  selected model, capability, or tool is unavailable. Guardrail decisions use
  `allow`, `block`, or a phase-specific `transform`; `reasonCode` remains safe
  for metrics and logs.

This unreleased API is a clean break. The repository intentionally contains no
compatibility aliases, migration workflow, or legacy configuration reader.
