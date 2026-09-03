# Capability inventory

## CAP-DB-FOUNDATION

Requirement: REQ-DB-FOUNDATION. Owner: Harness maintainer. Actor: SDK author and addon. SDK entrypoint: `createDecisionEvidence and runDecisionOperation`. Outcome: Validated evidence and one bounded callback result. Contract refs: CTR-DB-EVIDENCE, CTR-DB-LIFECYCLE, CTR-DB-IDENTITY. The exact success/failure/recovery edges and acceptance IDs are in `00-traceability.yaml`; verification: `ai-harness/packages/harness/src/decisions/decisions.test.ts`.

## CAP-DB-GOVERNANCE

Requirement: REQ-DB-GOVERNANCE. Owner: Harness maintainer. Actor: application policy adapter. SDK entrypoint: `HarnessBuilder.governance and agent permissions`. Outcome: One approved effective demand executes one tool. Contract refs: CTR-DB-GOVERNANCE, CTR-DB-IDENTITY. The exact success/failure/recovery edges and acceptance IDs are in `00-traceability.yaml`; verification: `ai-harness/packages/harness/test/governance.test.ts`.

## CAP-DB-PROVIDERS

Requirement: REQ-DB-PROVIDERS. Owner: Harness maintainer. Actor: provider adapter. SDK entrypoint: `ModelProvider response and subsequent request mapper`. Outcome: Synthetic reasoning survives and transformed wire arguments are sent. Contract refs: CTR-DB-CONTINUATION. The exact success/failure/recovery edges and acceptance IDs are in `00-traceability.yaml`; verification: `ai-harness/packages/harness-openai/test/openai.test.ts`.

## CAP-DB-TOOLS

Requirement: REQ-DB-TOOLS. Owner: Harness maintainer. Actor: default-loop agent caller. SDK entrypoint: `runDefaultAgent tool dispatch and final output`. Outcome: Preflight produces one effective call for history and model replay. Contract refs: CTR-DB-TOOLS, CTR-DB-RAILS. The exact success/failure/recovery edges and acceptance IDs are in `00-traceability.yaml`; verification: `ai-harness/packages/harness/test/agent-interceptors.test.ts`.

## CAP-DB-RAILS

Requirement: REQ-DB-RAILS. Owner: Harness maintainer. Actor: guardrails consumer. SDK entrypoint: direct agent `guardrails` binding and `filterRetrievedChunks`. Outcome: Input tool and final-output rails compose with governance. Contract refs: CTR-DB-RAILS, CTR-DB-EVIDENCE. The exact success/failure/recovery edges and acceptance IDs are in `00-traceability.yaml`; verification: `ai-harness/packages/harness-guardrails/test/guardrails.test.ts`.

## CAP-DB-WAITS

Requirement: REQ-DB-WAITS. Owner: Harness maintainer. Actor: durable workflow and storage adapter. SDK entrypoint: `externalWait.wait registerWait signalWait`. Outcome: Registration readback and terminal results use exact canonical shape. Contract refs: CTR-DB-WAITS. The exact success/failure/recovery edges and acceptance IDs are in `00-traceability.yaml`; verification: `ai-harness/packages/harness/test/durable-external-wait.test.ts`.

## CAP-DB-REVIEW

Requirement: REQ-DB-REVIEW. Owner: application. Actor: application reviewer and worker. SDK entrypoint: `reviewPayment workflow and ReviewTaskStore`. Outcome: Approved action records one admitted execution and receipt. Contract refs: CTR-DB-REVIEW. The exact success/failure/recovery edges and acceptance IDs are in `00-traceability.yaml`; verification: `ai-harness/examples/durable-human-review/src/payment-review.test.ts`.

## CAP-DB-CONSUMERS

Requirement: REQ-DB-CONSUMERS. Owner: Harness maintainer. Actor: PURISTA service and app author. SDK entrypoint: `AgentQueueBuilder executor and SSE projection`. Outcome: New public contracts forward through Core with no provider dependency. Contract refs: CTR-DB-CONSUMERS. The exact success/failure/recovery edges and acceptance IDs are in `00-traceability.yaml`; verification: `purista/packages/core/src/AgentQueueBuilder/agentQueueBuilder.test.ts`.

## CAP-DB-DOCS

Requirement: REQ-DB-DOCS. Owner: Harness maintainer. Actor: developer and operator. SDK entrypoint: `handbook package docs canonical skills examples`. Outcome: One example composes content rails, durable tool approval interruption/resume, and workflow review ownership. Contract refs: CTR-DB-DOCS. The exact success/failure/recovery edges and acceptance IDs are in `00-traceability.yaml`; verification: `purista/scripts/knowledge-audit.mjs`.

## CAP-DB-CLEANUP

Requirement: REQ-DB-CLEANUP. Owner: Harness maintainer. Actor: maintainer and independent reviewer. SDK entrypoint: `workspace verification and removal inventory`. Outcome: All changed consumers and package exports pass no-drift gates. Contract refs: CTR-DB-CLEANUP. The exact success/failure/recovery edges and acceptance IDs are in `00-traceability.yaml`; verification: `ai-harness/scripts/check-decision-boundaries.mjs`.

User-facing SDK, provider integration, application worker/review, data lifecycle, developer documentation, and operational capabilities are covered. Admin UI, CLI/server endpoints, new queues, and frontend component work are not applicable per `00-applicability.yaml`.
