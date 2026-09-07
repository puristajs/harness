# `@purista/harness` specification v4

This folder is the authoritative specification for Harness core and its
first-party provider and infrastructure packages.

Read [spec 42](./42-composable-definitions-and-catalogs.md) first. It defines
the complete v4 authoring, immutable composition, type inference, runtime,
streaming, approval, and host-integration contract. Topic specifications then
define the detailed behavior of ports and focused capabilities. A topic file
cannot add a second authoring surface, mutable registry, string service
locator, broader public-root set, or alternate runtime lifecycle.

All Harness-owned structured execution state uses the
[HarnessStorage contract](./32-harness-storage.md). The distributed reference
deployment uses the
[PostgreSQL and Kubernetes stack](./43-distributed-production-reference-stack.md).

## Reading order

1. [42 — composable definitions and catalogs](./42-composable-definitions-and-catalogs.md)
2. [00 — overview](./00-overview.md)
3. [01 — architecture](./01-architecture.md)
4. [02 — definition and runtime configuration](./02-harness-config.md)
5. [06 — model provider](./06-models.md)
6. [07 — tools and MCP](./07-tools.md)
7. [08 — Agent Skills](./08-skills.md)
8. [09 — agents](./09-agents.md)
9. [10 — workflows](./10-workflows.md)
10. [11 — sessions](./11-sessions.md)
11. [12 — streaming](./12-streaming.md)
12. [13 — public API index](./13-public-api.md)
13. [15 — error catalog](./15-error-catalog.md)
14. [16 — testing](./16-testing.md)
15. [17 — implementation-plan authority](./17-implementation-plan.md)

Implementation agents then load only the topic specifications needed for their
ticket.

## Topic index

| Topic | Owner |
| --- | --- |
| Logging, errors, telemetry bootstrap | [03-foundation](./03-foundation.md) |
| Persisted state and run events | [04-state-queue-stream](./04-state-queue-stream.md), [32-harness-storage](./32-harness-storage.md) |
| Sandbox filesystem and execution | [05-sandbox](./05-sandbox.md) |
| OpenTelemetry naming | [14-otel-conventions](./14-otel-conventions.md) |
| Testing fakes, contracts, and gates | [16-testing](./16-testing.md) |
| Runtime telemetry and evaluation foundation | [19-ai-eval-core](./19-ai-eval-core.md) |
| Memory orchestration and adapters | [33-enterprise-memory](./33-enterprise-memory/00-vision.md) |
| Durable workspaces and local durability | [21-durable-workspaces](./21-durable-workspaces.md), [22-local-durable-execution](./22-local-durable-execution.md) |
| Provider outcomes and retry | [23-provider-outcomes-and-retry](./23-provider-outcomes-and-retry.md) |
| Governance and approval | [24-governance-policy](./24-governance-policy.md), [37-decision-boundaries](./37-decision-boundaries/00-vision.md) |
| Context projection and bounded recovery | [26-context-projection-and-compaction](./26-context-projection-and-compaction.md) |
| Sanitized test replay and diagnostics | [27-test-replay-and-diagnostic-invariants](./27-test-replay-and-diagnostic-invariants.md) |
| Workflow child tasks and fan-out | [28-workflow-child-tasks](./28-workflow-child-tasks.md) |
| Agent Plugin inspection/projection | [29-agent-plugins](./29-agent-plugins.md) |
| Guardrails and sensitive data | [30-guardrails](./30-guardrails.md), [31-sensitive-data-guardrails](./31-sensitive-data-guardrails.md), [38-guardrail-authoring](./38-guardrail-authoring/00-vision.md) |
| Distributed Sandbox lifecycle and ownership | [34-distributed-sandbox-lifecycle](./34-distributed-sandbox-lifecycle/00-vision.md), [36-sandbox-ownership-and-administration](./36-sandbox-ownership-and-administration/00-vision.md) |
| Generic evaluation runs | [35-generic-evaluation-runs](./35-generic-evaluation-runs.md) |
| Standard Schema boundaries | [39-standard-schema-boundaries](./39-standard-schema-boundaries/00-vision.md) |
| OPA policy adapter | [41-opa-policy-adapter](./41-opa-policy-adapter.md) |
| Distributed production stack | [43-distributed-production-reference-stack](./43-distributed-production-reference-stack.md) |

## Archived decision records

[Spec 25](./25-static-harness-modules.md) and
[spec 40](./40-declarative-registration-and-guardrails-binding.md) are concise
records of replaced design work. They contain no active authoring or runtime
contract. Historical readiness records are evidence of prior decisions and
must be explicitly marked superseded when a later contract replaces them.

## Normative ownership rules

- Spec 42 owns public definition factories, direct references, catalogs,
  executable roots, graph closure, `$infer`, runtime binding, invokers,
  streaming, admission, host tools, and PURISTA integration requirements.
- Spec 39 owns Standard Schema and Standard JSON Schema direction, validation,
  projection, and caching.
- Spec 37 owns decision evidence, approval, continuation, and prepared-tool
  ordering.
- Spec 38 owns Guardrail action/configuration semantics; spec 42 owns how a
  typed binding attaches to an agent and contributes graph requirements.
- Spec 32 owns the single persistence boundary and authoritative run model.
- Specs 34 and 36 own topology-transparent Sandbox lifecycle and owner
  authorization.
- Spec 43 owns the selected distributed storage and Sandbox reference stack.

If two active files conflict, that is a specification defect. An implementation
agent must stop that ticket and route the contradiction to readiness review
rather than choose one interpretation.

## Clean-break rule

The v4 release contains one current API and one execution path. Source, tests,
examples, generated templates, package declarations, documentation, diagrams,
skills, and public knowledge must contain no compatibility wrapper, deprecated
alias, dual runtime behavior, or stale recommended example.

Historical records may name removed concepts solely to identify what is no
longer active. They cannot define types, examples, or fallback behavior.

## Readiness and plan

- Repository readiness record: [`.readiness-report.yaml`](./.readiness-report.yaml)
- Executable workspace plan:
  [`plans/harness-v4-clean-break/plan.json`](../../plans/harness-v4-clean-break/plan.json)

A human-approved intent does not substitute for independent semantic review,
current scope digests, or implementation verification. The plan must bind the
latest approved specification digest before implementation tickets become
ready.
