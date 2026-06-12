# Workflow Delegation Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add low-effort, safe-by-default workflow subagent delegation controls to `@purista/harness`.

**Architecture:** Keep agents as leaf model loops and workflows as the local orchestrator. Add opt-in workflow/default delegation policy, enforce it in the existing workflow `ctx.agents` wrapper, and preserve low-effort DX with explicit workflow policies and bounded defaults after opt-in.

**Tech Stack:** TypeScript, Zod, Vitest, `@purista/harness` builder/session/runtime APIs.

---

## File Structure

- `packages/harness/src/harness/defineHarness.ts`: public types for delegation defaults, workflow policy, typed child-agent invoke options, run events, and builder validation.
- `packages/harness/src/sessions/index.ts`: runtime enforcement for allowlists, total calls, parallel calls, model alias overrides, and child lineage metadata.
- `packages/harness/src/errors/catalog.ts`: dedicated delegation policy error.
- `packages/harness/test/workflow-delegation.test.ts`: red-green coverage for policy defaults, overrides, model alias selection, event lineage, and persisted redaction.
- `packages/harness/type-tests/harness-typing.ts`: compile-time coverage for `delegation.agents`, `delegation.models`, and child-agent `model` override keys.
- `specs/10-workflows.md`, `specs/11-sessions.md`, `specs/12-streaming.md`, `specs/13-public-api.md`: source-of-truth specs.
- `docs/guides/workflows.md`, `docs/guides/configuration.md`, `docs/reference/public-api.md`: user-facing docs.
- `skills/ai-harness/SKILL.md`, `skills/ai-harness/references/agents-workflows-tools.md`, `skills/ai-harness/references/configuration.md`, `skills/ai-harness/references/state-sessions-streaming-errors.md`, `skills/ai-harness/references/telemetry-observability.md`: skill catalog updates.
- `examples/quickstart` or `examples/showcase`: add one concise delegation-policy example if an existing workflow example is present and suitable.
- package manifests and lockfile: bump all harness package versions consistently.

## Tasks

### Task 1: Red Tests For Workflow Delegation

- [x] Add `packages/harness/test/workflow-delegation.test.ts`.
- [x] Cover: default total-call budget, workflow call allowlist, per-workflow parallel budget, model alias override, model override denial, event lineage fields, and sanitized persisted event metadata.
- [x] Run `npm run test --workspace @purista/harness -- workflow-delegation`.
- [x] Expected: fails because the new `delegation` API and runtime behavior do not exist.

### Task 2: Public Types And Validation

- [x] Add `DelegationDefaults`, `WorkflowDelegationPolicy`, and `WorkflowAgentInvokeOptions` to `defineHarness.ts`.
- [x] Add `delegation?: DelegationDefaults` to `HarnessDefaults`.
- [x] Add `delegation?: WorkflowDelegationPolicy<...>` to workflow definitions.
- [x] Update `WorkflowContext.agents` so child calls accept typed model alias overrides.
- [x] Validate numeric delegation defaults in `Builder.defaults(...)`.
- [x] Run the failing workflow-delegation test again.
- [x] Expected: type/runtime failures move from missing fields toward missing enforcement.

### Task 3: Runtime Enforcement

- [x] Add a `DelegationPolicyError` for exceeded/denied delegation.
- [x] Resolve effective policy from defaults plus workflow-specific overrides.
- [x] Enforce allowed child agents before execution.
- [x] Enforce total child calls per workflow run.
- [x] Enforce max parallel child calls.
- [x] Enforce model alias allowlists and pass selected model alias into `runDefaultAgent`.
- [x] Preserve existing cancellation and history-window behavior.
- [x] Run `npm run test --workspace @purista/harness -- workflow-delegation`.
- [x] Expected: tests pass.

### Task 4: Lineage And Summaries

- [x] Add optional `workflowId`, `parentAgentId`, `delegationCallId`, `delegationDepth`, and `modelAlias` fields to `agent.started` / `agent.finished` events.
- [x] Persist only non-content lineage metadata.
- [x] Add telemetry span attributes for delegation lineage and model alias.
- [x] Keep `RunSummary.agentCalls` behavior compatible.
- [x] Run `npm run test --workspace @purista/harness -- workflow-delegation run-events telemetry-flow`.
- [x] Expected: targeted tests pass.

### Task 5: Type Tests

- [x] Add type assertions for delegation agent/model keys and `ctx.agents.child(..., { model })`.
- [x] Run `npm run test:types --workspace @purista/harness`.
- [x] Expected: type tests pass.

### Task 6: Specs, Docs, Skills, Examples

- [x] Update workflow/session/streaming/public-api specs.
- [x] Update workflow/configuration/public API docs.
- [x] Update ai-harness skill references.
- [x] Add or update one example with a small delegation policy.
- [x] Run docs-sensitive checks available in the repo if present.

### Task 7: Version Bump And Verification

- [x] Bump all harness packages consistently.
- [x] Update lockfile.
- [x] Run:
  - `npm run test --workspace @purista/harness`
  - `npm run test:types --workspace @purista/harness`
  - `npm run build`
- [x] Review `git diff`.
- [x] Commit, push branch, and open PR against `main`.
