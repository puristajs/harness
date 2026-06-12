# Agent Guidance

This repository defines a self-hosted enterprise agent harness. It is lower-level harness infrastructure, not a SaaS product.

## Source of Truth

- Approved specs: `specs/`
- Approved readiness gate: `specs/.readiness-report.yaml`
- Product, architecture, and scope: `specs/00-overview.md`, `specs/01-architecture.md`
- Stack and public API: `specs/02-harness-config.md`, `specs/13-public-api.md`
- Interfaces and ports: `specs/04-state-queue-stream.md`, `specs/05-sandbox.md`, `specs/06-models.md`, `specs/07-tools.md`
- Failure handling: `specs/15-error-catalog.md`
- Test strategy: `specs/16-testing.md`
- Plans, reviews, and tickets: `plans/` (review findings and implementation plans live here, not under `docs/`)
- Implementation conventions: `.agent/IMPLEMENTATION.md`

Use `specs/` and `plans/` as the only approved definition sources. Historical
review material and previous implementation code are not source of truth.

## Repository Rules

- Use npm workspaces for TypeScript packages unless the specs are changed by a human.
- Keep shared harness logic in `packages/`.
- v1 has no deployable service/workers/apps package; examples under `examples/` are private workspaces.
- Core harness code depends on ports and contracts, not concrete provider SDKs.
- Adapter packages own provider SDK dependencies and must pass shared contract tests.
- Harness code must not depend on `evals/`, `k8s/`, or repo-local `skills/`.

## Expected Commands

- `npm run lint`
- `npm run build`
- `npm test`
- `npm run test:coverage`
- `npm run test:types`
- `npm run test:contracts`
- `npm run test:integration`
- `npm run test:failure`

## Implementation Rules

- Follow each ticket's `write_scope` and `read_scope`.
- Do not invent missing contracts, interfaces, data models, or failure behavior during implementation.
- If a ticket depends on missing definition work, flag it in `specs/.readiness-report.yaml` or add a gap report under `plans/` instead of guessing.
- Preserve timeout, retry, idempotency, cleanup, DLQ/manual-intervention, backpressure, and telemetry behavior from specs.
