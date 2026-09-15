# Sandbox and evaluation direction

Status: executive research brief, not an approved specification

Date: 2026-08-25

This brief summarizes the decisions proposed by:

- [Distributed sandbox architecture research](./2026-08-25-distributed-sandbox-architecture-research.md)
- [Practical AI evaluation roadmap](./2026-08-25-practical-ai-evaluation-roadmap.md)

## Recommended direction

| Topic | Product boundary | Recommended first move | Do not do |
| --- | --- | --- | --- |
| Distributed sandboxes | Harness defines scoped lifecycle, ownership, fencing, workspace recovery, and a provider port. A remote or self-hosted control plane owns compute placement and isolation. | Specify a multi-instance sandbox contract, then spike E2B and Daytona with identical concurrency/failure tests. | Do not describe sticky sessions or a shared filesystem as a complete distributed solution. Do not silently create a blank sandbox when reattachment fails. |
| Evaluations | Harness runs reproducible cases/scorers and emits safe per-case results/correlations. External platforms own dataset UI, experiments, annotation, dashboards, and production analytics. | Repair current drift, then specify a generic per-case evaluation result model before adding RAG/agent metrics. | Do not build an evaluation SaaS inside core. Do not reduce safety, quality, latency, and cost to one unexplained score. |

## Shared architectural principle

Both topics require portable control records rather than process-local state:

- A sandbox request needs a stable scoped key, an opaque provider reference, a
  generation, and a fenced owner.
- An evaluation result needs stable dataset/case/candidate/scorer identities,
  safe evidence, and run/trace correlation.
- Raw model content, secrets, provider handles, and host paths should not become
  shared coordination data or default telemetry.
- Provider-specific functionality belongs in optional adapters and examples.

This keeps stateless application replicas interchangeable while making state
transitions explicit and observable.

## Proposed sequence

### Now: accuracy and decision specs

1. Correct the evaluation testing example and resolve the declared-but-missing
   `harness.eval.*` telemetry behavior.
2. Document current local sandboxes as single-process development adapters.
3. Approve a distributed sandbox lifecycle/ownership specification.
4. Approve a generic evaluation run/result specification.

### Next: prove the abstractions

1. Add multi-instance sandbox contract tests using two adapter instances,
   concurrent open, fencing, owner loss, restore, and cross-tenant rejection.
2. Spike E2B and Daytona, select one reference adapter from evidence, and test it
   with two Harness replicas plus shared storage.
3. Implement per-case, multi-scorer evaluation results with errors, evidence,
   correlations, concurrency, cancellation, and privacy-safe telemetry.
4. Publish the beginner “evaluation in one hour” and “multi-instance sandboxes”
   handbook pages against tested examples.

### Then: domain and provider guides

1. Add RAG, agent trajectory, workflow invariant, and guardrail helpers only on
   top of the generic evaluation substrate.
2. Publish Langfuse and Datadog integrations first, followed by Phoenix and one
   specialized experiment platform example.
3. Publish the self-hosted sandbox operator architecture for enterprise teams
   whose compliance requirements exclude a managed control plane.

## Decisions needed before implementation

1. Is the reference distributed sandbox expected to preserve live processes, or
   are file checkpoints plus process restart sufficient? This is the largest
   differentiator in the provider bake-off.
2. Is BYOC/self-hosting a launch requirement for the reference adapter or an
   advanced follow-up?
3. Should shared-sandbox use require durable-run semantics, or should ordinary
   sessions also gain storage-backed ownership?
4. Should the first generic evaluation API live in `@purista/harness`, or in a
   separate optional evaluation package after the result contract is approved?
5. Which integration pair best represents the intended audience: Langfuse plus
   Datadog is the proposed default because it covers evaluation-focused and
   existing-enterprise-observability workflows.

## Outcome to optimize for

An enterprise team should be able to:

- scale Harness replicas without occasionally receiving a fresh, drifted
  sandbox under an existing logical session;
- recover explicitly when live compute disappears;
- build a small, understandable evaluation baseline before choosing a vendor;
- identify whether a regression came from retrieval, generation, tool use,
  workflow state, or a guardrail;
- connect the same provider-neutral application behavior to an enterprise
  evaluation/observability platform without coupling Harness core to that vendor.
