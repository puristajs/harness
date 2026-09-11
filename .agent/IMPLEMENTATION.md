# Implementation Guide

Repository-level agent instructions live in `AGENTS.md`. This file contains implementation conventions only.

## Source Order

Use this order when instructions conflict:

1. `specs/.readiness-report.yaml`
2. `specs/`
3. `plans/`
4. This guide
5. Language and npm defaults

Use `specs/` and `plans/` as the only approved definition sources. Historical
review material and previous implementation code are not source of truth.

## Project Shape

The repository is npm-workspace based and library-first. `@purista/harness`
owns provider-neutral runtime contracts. Published provider packages include
OpenAI, Anthropic, Bedrock, and Azure Foundry; `@purista/harness-guardrails`
owns content rails and its optional detector packages own concrete detection.
These addons consume public core exports, not private runtime modules.
Examples are private workspaces used for integration and documentation.

Expected root:

- `docs/`
- `specs/`
- `plans/`
- `packages/`
- `examples/`
- `skills/`

## TypeScript

- Use strict TypeScript.
- Use npm workspaces.
- Do not author `.js` or `.mjs` in `packages` or `examples`.
- Use Zod v4 or newer as runtime validation source.
- Infer TypeScript types from Zod schemas where possible.
- Keep public interfaces explicit and provider-neutral.

## Public Interface Documentation

- Add TSDoc to exported SDK methods, runtime contracts, ports, public errors,
  helper functions, config fields, and extension points.
- Explain what the caller provides, what the runtime owns, what references point
  to, and what output or side effect to expect.
- Add Zod `.describe(...)` metadata where it improves generated JSON Schema,
  OpenAPI, AsyncAPI, or reference documentation.
- Keep comments on public contracts and non-obvious logic. Do not add filler
  comments that restate the type name.

## Examples

- Prefer focused example modules that each teach one concept: setup/config,
  prompts, definitions, final response, streaming, structured output,
  multimodal input, approvals, cancellation, sandbox/skills, adapters, and
  multi-agent workflows.
- Keep one end-to-end example as an integration walkthrough after focused
  examples exist.
- Example READMEs must explain where values are defined, how refs resolve, what
  the developer edits, what the runtime owns, and what output to expect.
- Example code should use real package names, exported types, and npm commands
  from this repo.
- Register native TypeScript tools only through `.tools(({ tool }) => ({
  name: tool({ ... }) }))`. The helper is builder-local so it preserves schema,
  handler, and sandbox inference; raw native tool objects fail during
  `.tools(...)` registration. MCP literal tools remain their explicit
  external-integration form.
- Configure Guardrails only as an inline `defineGuardrails({ config, actions })`
  object. Create opaque action tokens with `defineGuardrailAction`, bind model
  checks to direct registered aliases, and scope structured tools explicitly.

## Dependency Boundaries

Provider-neutral packages must not import concrete provider or infrastructure SDKs.

Concrete provider dependencies belong outside the provider-neutral harness core:

- OpenAI SDK dependencies belong in `packages/harness-openai`.
- OpenTelemetry SDK/exporters belong at application or example boundaries, not in core.
- Future database, queue, sandbox, or secret-manager clients belong in future
  `@purista/harness-{addon}` packages if the specs approve them.

## Modules

- `packages/harness`: provider-neutral harness core, ports, built-in tools, skills, sessions, workflows, errors, logging, telemetry shims, and testing helpers.
- `packages/harness-openai`: OpenAI model provider package depending only on the public `@purista/harness` surface.
- `examples/quickstart`: private quickstart example.
- `examples/living-wiki-jaeger` and other spec-approved examples: private example workspaces, not deployable product packages.

## Tests

Use the verification commands from each ticket. Default gates:

- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run test:contracts`
- `npm run test:failure`
- `npm run test:integration`
- `npm run build`

Production infrastructure/provider tests must be opt-in through explicit environment variables.

## Errors and Logging

- Use canonical runtime errors internally.
- Render RFC 9457 Problem Details at API and SDK boundaries.
- Use structured JSON logs with trace correlation.
- Do not log raw secrets, sensitive payloads, or unredacted model/tool context.

## Implementation Discipline

- Follow ticket `write_scope` and `read_scope`.
- Do not invent missing contracts or behavior.
- If specs are insufficient, update a gap report instead of coding around ambiguity.
- Add behavior tests for acceptance criteria.
- Preserve timeout, retry, idempotency, cleanup, DLQ, backpressure, telemetry, and policy semantics.

## Convention Drift

When implementation files, package metadata, or examples disagree with
`specs/`, treat the specs and readiness report as authoritative. Fix guidance
files when they reference obsolete spec paths or pre-v1 module names.
