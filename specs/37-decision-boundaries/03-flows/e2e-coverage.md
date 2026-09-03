# End-to-end definition chains

All capabilities require registered definitions and the documented opt-in boundary. Sources are `00-traceability.yaml` and `03-contracts/contracts.yaml`.

## REQ-DB-FOUNDATION

CAP-DB-FOUNDATION: actor SDK author and addon; entrypoint `createDecisionEvidence and runDecisionOperation`. Reachability: application builder/runtime registration invokes this boundary; no implicit provider or global service. Contracts: CTR-DB-EVIDENCE, CTR-DB-LIFECYCLE, CTR-DB-IDENTITY.

- PATH-DB-FOUNDATION-SUCCESS: Validated evidence and one bounded callback result.
- PATH-DB-FOUNDATION-FAILURE: Malformed output or expired/pre-aborted callback invokes no protected work.
- PATH-DB-FOUNDATION-RECOVERY: Late callback resolution is fenced and listeners/timers return to baseline.
- Data/state/effects: transient values and safe decision records; only existing tool/domain handlers perform business effects; wait capabilities use existing storage transactions.
- Permissions: no approval or transform grants authority; application guards remain mandatory. Errors and recovery follow the cited contract. Observability uses the evidence projection and existing correlated spans; no raw content is logged. Final states are the three outcomes above.
- Acceptance: AC-DB-FOUNDATION-SUCCESS, AC-DB-FOUNDATION-FAILURE, AC-DB-FOUNDATION-RECOVERY; verification `ai-harness/packages/harness/src/decisions/decisions.test.ts`. Runtime owner is the owning package maintainer.

## REQ-DB-GOVERNANCE

CAP-DB-GOVERNANCE: actor application policy adapter; entrypoint `HarnessBuilder.governance and agent permissions`. Reachability: application builder/runtime registration invokes this boundary; no implicit provider or global service. Contracts: CTR-DB-GOVERNANCE, CTR-DB-IDENTITY.

- PATH-DB-GOVERNANCE-SUCCESS: One approved effective demand executes one tool.
- PATH-DB-GOVERNANCE-FAILURE: Deny suppresses approval; malformed callback terminates with safe evidence.
- PATH-DB-GOVERNANCE-RECOVERY: Cancellation and audit failure close approval lifecycle without late execution.
- Data/state/effects: transient values and safe decision records; only existing tool/domain handlers perform business effects; wait capabilities use existing storage transactions.
- Permissions: no approval or transform grants authority; application guards remain mandatory. Errors and recovery follow the cited contract. Observability uses the evidence projection and existing correlated spans; no raw content is logged. Final states are the three outcomes above.
- Acceptance: AC-DB-GOVERNANCE-SUCCESS, AC-DB-GOVERNANCE-FAILURE, AC-DB-GOVERNANCE-RECOVERY; verification `ai-harness/packages/harness/test/governance.test.ts`. Runtime owner is the owning package maintainer.

## REQ-DB-PROVIDERS

CAP-DB-PROVIDERS: actor provider adapter; entrypoint `ModelProvider response and subsequent request mapper`. Reachability: application builder/runtime registration invokes this boundary; no implicit provider or global service. Contracts: CTR-DB-CONTINUATION.

- PATH-DB-PROVIDERS-SUCCESS: Synthetic reasoning survives and transformed wire arguments are sent.
- PATH-DB-PROVIDERS-FAILURE: Unknown duplicate or missing tool slots reject before provider call.
- PATH-DB-PROVIDERS-RECOVERY: Foreign-provider switch reconstructs canonical content without old field fallback.
- Data/state/effects: transient values and safe decision records; only existing tool/domain handlers perform business effects; wait capabilities use existing storage transactions.
- Permissions: no approval or transform grants authority; application guards remain mandatory. Errors and recovery follow the cited contract. Observability uses the evidence projection and existing correlated spans; no raw content is logged. Final states are the three outcomes above.
- Acceptance: AC-DB-PROVIDERS-SUCCESS, AC-DB-PROVIDERS-FAILURE, AC-DB-PROVIDERS-RECOVERY; verification `ai-harness/packages/harness-openai/test/openai.test.ts`. Runtime owner is the owning package maintainer.

## REQ-DB-TOOLS

CAP-DB-TOOLS: actor default-loop agent caller; entrypoint `runDefaultAgent tool dispatch and final output`. Reachability: application builder/runtime registration invokes this boundary; no implicit provider or global service. Contracts: CTR-DB-TOOLS, CTR-DB-RAILS.

- PATH-DB-TOOLS-SUCCESS: Preflight produces one effective call for history and model replay.
- PATH-DB-TOOLS-FAILURE: Terminal preflight block starts no handler in the response batch.
- PATH-DB-TOOLS-RECOVERY: Batch cancellation stops admission drains wrappers and fences late outputs.
- Data/state/effects: transient values and safe decision records; only existing tool/domain handlers perform business effects; wait capabilities use existing storage transactions.
- Permissions: no approval or transform grants authority; application guards remain mandatory. Errors and recovery follow the cited contract. Observability uses the evidence projection and existing correlated spans; no raw content is logged. Final states are the three outcomes above.
- Acceptance: AC-DB-TOOLS-SUCCESS, AC-DB-TOOLS-FAILURE, AC-DB-TOOLS-RECOVERY; verification `ai-harness/packages/harness/test/agent-interceptors.test.ts`. Runtime owner is the owning package maintainer.

## REQ-DB-RAILS

CAP-DB-RAILS: actor guardrails consumer; entrypoint direct agent `guardrails` binding and `filterRetrievedChunks`. Reachability: application builder/runtime registration invokes this boundary; no implicit provider or global service. Contracts: CTR-DB-RAILS, CTR-DB-EVIDENCE.

- PATH-DB-RAILS-SUCCESS: Input tool and final-output rails compose with governance.
- PATH-DB-RAILS-FAILURE: Invalid phase target transform declaration or JSON fails closed.
- PATH-DB-RAILS-RECOVERY: Tool turns bypass final output rails; stopWhen finalization remains protected.
- Data/state/effects: transient values and safe decision records; only existing tool/domain handlers perform business effects; wait capabilities use existing storage transactions.
- Permissions: no approval or transform grants authority; application guards remain mandatory. Errors and recovery follow the cited contract. Observability uses the evidence projection and existing correlated spans; no raw content is logged. Final states are the three outcomes above.
- Acceptance: AC-DB-RAILS-SUCCESS, AC-DB-RAILS-FAILURE, AC-DB-RAILS-RECOVERY; verification `ai-harness/packages/harness-guardrails/test/guardrails.test.ts`. Runtime owner is the owning package maintainer.

## REQ-DB-WAITS

CAP-DB-WAITS: actor durable workflow and storage adapter; entrypoint `externalWait.wait registerWait signalWait`. Reachability: application builder/runtime registration invokes this boundary; no implicit provider or global service. Contracts: CTR-DB-WAITS.

- PATH-DB-WAITS-SUCCESS: Registration readback and terminal results use exact canonical shape.
- PATH-DB-WAITS-FAILURE: Missing extra invalid fields rejected before telemetry or persistence.
- PATH-DB-WAITS-RECOVERY: Duplicate and late signals retain current terminal state and replay semantics.
- Data/state/effects: transient values and safe decision records; only existing tool/domain handlers perform business effects; wait capabilities use existing storage transactions.
- Permissions: no approval or transform grants authority; application guards remain mandatory. Errors and recovery follow the cited contract. Observability uses the evidence projection and existing correlated spans; no raw content is logged. Final states are the three outcomes above.
- Acceptance: AC-DB-WAITS-SUCCESS, AC-DB-WAITS-FAILURE, AC-DB-WAITS-RECOVERY; verification `ai-harness/packages/harness/test/durable-external-wait.test.ts`. Runtime owner is the owning package maintainer.

## REQ-DB-REVIEW

CAP-DB-REVIEW: actor application reviewer and worker; entrypoint `reviewPayment workflow and ReviewTaskStore`. Reachability: application builder/runtime registration invokes this boundary; no implicit provider or global service. Contracts: CTR-DB-REVIEW.

- PATH-DB-REVIEW-SUCCESS: Approved action records one admitted execution and receipt.
- PATH-DB-REVIEW-FAILURE: Unauthorized expired changed or conflicting action has no new effect.
- PATH-DB-REVIEW-RECOVERY: Every claim effect receipt checkpoint crash window resumes same execution identity.
- Data/state/effects: application review claim and receipt; existing storage wait and checkpoint; one idempotent domain operation.
- Permissions: no approval or transform grants authority; application guards remain mandatory. Errors and recovery follow the cited contract. Observability uses the evidence projection and existing correlated spans; no raw content is logged. Final states are the three outcomes above.
- Acceptance: AC-DB-REVIEW-SUCCESS, AC-DB-REVIEW-FAILURE, AC-DB-REVIEW-RECOVERY; verification `ai-harness/examples/durable-human-review/src/payment-review.test.ts`. Runtime owner is application.

## REQ-DB-CONSUMERS

CAP-DB-CONSUMERS: actor PURISTA service and app author; entrypoint `AgentQueueBuilder executor and SSE projection`. Reachability: application builder/runtime registration invokes this boundary; no implicit provider or global service. Contracts: CTR-DB-CONSUMERS.

- PATH-DB-CONSUMERS-SUCCESS: New public contracts forward through Core with no provider dependency.
- PATH-DB-CONSUMERS-FAILURE: Removed hook/type/event fields fail consumer compile or config validation.
- PATH-DB-CONSUMERS-RECOVERY: Existing queue/run idempotency and scoped resource authorization remain intact.
- Data/state/effects: transient values and safe decision records; only existing tool/domain handlers perform business effects; wait capabilities use existing storage transactions.
- Permissions: no approval or transform grants authority; application guards remain mandatory. Errors and recovery follow the cited contract. Observability uses the evidence projection and existing correlated spans; no raw content is logged. Final states are the three outcomes above.
- Acceptance: AC-DB-CONSUMERS-SUCCESS, AC-DB-CONSUMERS-FAILURE, AC-DB-CONSUMERS-RECOVERY; verification `purista/packages/core/src/AgentQueueBuilder/agentQueueBuilder.test.ts`. Runtime owner is the owning package maintainer.

## REQ-DB-DOCS

CAP-DB-DOCS: actor developer and operator; entrypoint `handbook package docs canonical skills examples`. Reachability: application builder/runtime registration invokes this boundary; no implicit provider or global service. Contracts: CTR-DB-DOCS.

- PATH-DB-DOCS-SUCCESS: One example composes content rails, durable tool approval interruption/resume, and workflow review ownership.
- PATH-DB-DOCS-FAILURE: No recipe presents guardrail block as approval request or durable suspension.
- PATH-DB-DOCS-RECOVERY: Canonical skill mirrors regenerate from source and exact usage examples typecheck.
- Data/state/effects: transient values and safe decision records; only existing tool/domain handlers perform business effects; wait capabilities use existing storage transactions.
- Permissions: no approval or transform grants authority; application guards remain mandatory. Errors and recovery follow the cited contract. Observability uses the evidence projection and existing correlated spans; no raw content is logged. Final states are the three outcomes above.
- Acceptance: AC-DB-DOCS-SUCCESS, AC-DB-DOCS-FAILURE, AC-DB-DOCS-RECOVERY; verification `purista/scripts/knowledge-audit.mjs`. Runtime owner is the owning package maintainer.

## REQ-DB-CLEANUP

CAP-DB-CLEANUP: actor maintainer and independent reviewer; entrypoint `workspace verification and removal inventory`. Reachability: application builder/runtime registration invokes this boundary; no implicit provider or global service. Contracts: CTR-DB-CLEANUP.

- PATH-DB-CLEANUP-SUCCESS: All changed consumers and package exports pass no-drift gates.
- PATH-DB-CLEANUP-FAILURE: Removed names duplicate timers and unsafe projections fail static gate.
- PATH-DB-CLEANUP-RECOVERY: No destructive reset no old reader no compatibility mode is introduced.
- Data/state/effects: transient values and safe decision records; only existing tool/domain handlers perform business effects; wait capabilities use existing storage transactions.
- Permissions: no approval or transform grants authority; application guards remain mandatory. Errors and recovery follow the cited contract. Observability uses the evidence projection and existing correlated spans; no raw content is logged. Final states are the three outcomes above.
- Acceptance: AC-DB-CLEANUP-SUCCESS, AC-DB-CLEANUP-FAILURE, AC-DB-CLEANUP-RECOVERY; verification `ai-harness/scripts/check-decision-boundaries.mjs`. Runtime owner is the owning package maintainer.
