# Decision boundaries: approved clean refactor

## Authority and scope

The repository owner requested and approved this specification update on 2026-08-26 in task `01a03d51-6262-7480-89eb-baa163905ef6`: create a complete implementation plan, enforce PURISTA patterns and reuse, remove duplication, allow breaking changes, and provide no legacy APIs, backward compatibility, or migrations. This authorization applies to the exact content bound by this workstream's manifest and independent readiness review; implementation agents receive no authority to make additional semantic decisions.

The outcome is one maintainable decision boundary across core interception, optional guardrails, permissions, governance, durable tool approval, and workflow wait integration. Keep the different meanings and reducers; share schemas, evidence, identities, and prepared tool invocation. Reviewer authentication, authorization, business review state, and execution receipts remain application-owned.

This scope is an in-place clean boundary refactor, not a new runtime, package family, server, review UI, provider policy engine, or service. The Harness remains standalone; it must not import PURISTA Core. PURISTA consumes its public APIs and continues to own service guards, queues, and application resources. Existing starter/create-purista defaults remain free of mandatory governance configuration.

## Source of truth

`03-contracts/decisions.md`, `03-contracts/contracts.yaml`, `03-flows/e2e-coverage.md`, and the reciprocal `00-traceability.yaml` define the approved target. The machine-readable contracts index identifies the normative prose sections and the implementation schema owners; it is not a second runtime schema language. Readiness and ticket digests prevent substitution of a different target.

The audit at `../../plans/2026-08-26-guardrails-approval-alignment-audit.md` is historical evidence, not a competing specification. Its compatibility-facade and migration options are rejected by this approval. The linked flat specifications delegate the changed behavior to this workstream; unchanged detector, model, storage, and sandbox contracts remain in force.

Implementation completion means the changed runtime, all first-party providers, addon, examples, tests, in-scope PURISTA Core consumers, starter/create-purista source/templates, handbook, and skill sources agree; removed symbols and duplicate implementations are absent from active code. Voyage is an unrelated application and is explicitly outside this workstream. Passing one package or a fake-only demonstration is insufficient.

## Non-goals

No dependency upgrade, schema migration, dual reader, compatibility flag, deprecation alias, old/new adapter, remote service, consent UI, new payment implementation, authorization policy value, or live external smoke execution is authorized. No production data deletion or conversion is authorized. Deployment and data ownership requirements are explicit in `04-delivery/clean-cut.md`.
