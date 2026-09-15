# Guardrails, governance, and approval alignment

> Historical discovery evidence. The approved [decision-boundary spec](../specs/37-decision-boundaries/00-vision.md) and [implementation plan](./decision-boundaries/implementation-plan.md) replace its proposed options; no compatibility or migration path is authorized.

Date: 2026-08-26<br>
Status: advisory audit and design proposal; **not an approved implementation spec**<br>
Baseline: `c378607`, including the existing uncommitted working tree. Source code was not changed.

## Recommendation

Keep the existing responsibilities, but consolidate their supporting contracts and execution machinery. The most valuable change is **one consistent decision boundary**, not one universal decision type or one new safety framework.

The current architecture already makes a good distinction:

| Responsibility | Existing owner | Meaning |
| --- | --- | --- |
| Content inspection and transformation | Guardrails addon over core interceptors | Is this value acceptable at this boundary, or must it change? |
| Tool eligibility and business policy | Permissions and governance | May this declared tool execute for this invocation? |
| Immediate approval | Governance approval provider; built-in permission callback | Can an application decision be obtained during this execution? |
| Restart-safe waiting | Existing durable workflow and HarnessStorage external waits | Suspend and resume after an external terminal signal. |
| Human review and business authorization | Application | Who may approve which exact action, for how long, and how is execution recorded? |

Guardrails already reuse the default agent loop instead of building a second runtime. Governance already evaluates transformed, schema-parsed TypeScript tool input before the handler. Durable review already reuses steps and storage waits. Preserve those choices.

However, the implementations diverge in validation, diagnostic fields, callback cancellation, typing, and data provenance. Some divergence is a correctness issue, not merely style.

## Evidence and priorities

Effort: S = hours, M = approximately a day including tests, L = several days/design work. These are coarse estimates, not delivery commitments. Confidence is high for the findings below; proposed API designs still require approval.

| Priority | Finding | Impact | Effort | Change risk |
| --- | --- | --- | --- | --- |
| P0 | Malformed approval/permission results can permit execution | An integration error can cross an authorization boundary | M | Low–medium |
| P1 | Decision metadata has inconsistent privacy and error propagation | Content can enter diagnostics; applications cannot reliably classify rail blocks | M | Medium |
| P1 | Governance callbacks lack consistent cancellation and budgets | A slow policy or audit callback can stall an invocation | M | Medium |
| P1 | Durable example consumes approval before recoverable execution | A transient failure prevents the approved operation from being retried | M | Medium |
| P1 | Tool transformation does not update transcript/replay provenance | Handler and policy see a different request from subsequent model/history readers | L | High |
| P1 | External waits validate too late and do not project a strict shape | Malformed/extra fields can cross the advertised safe-data boundary | M | Low–medium |
| P2 | Output rails cannot distinguish final answers from tool-call turns | A normal string output rail can stop a tool-using agent before its tools run | M–L | Medium |
| P2 | Public types fail to express several existing guarantees | Multi-tool policy reuse, phase checking, and terminal wait handling require workarounds | M | Medium |
| P2 | Exposure decision IDs omit tool identity | Distinct decisions can share an audit identifier | S | Medium for downstream consumers |

### 1. Make every decision boundary fail closed

The approval path checks only whether the returned decision is exactly `rejected`; all other non-null objects proceed. The permission callback similarly returns an unchecked value, and execution only checks for exact `deny`.

Evidence:

- [Approval result enforcement](../packages/harness/src/agents/index.ts#L981), particularly the condition at line 1008.
- [Permission callback normalization](../packages/harness/src/agents/index.ts#L65), consumed at line 803.
- [Guardrail result validation](../packages/harness-guardrails/src/rails.ts#L369): checks decision/target and array shape, but not complete JSON compatibility of transformed values.
- [Generic interception](../packages/harness/src/agents/index.ts#L492): all falsy hook returns are treated as no-op, although only `void` is declared.

In-memory probes confirmed malformed approval and permission results can execute an in-memory tool. A retrieval transform containing a non-JSON array element was also accepted.

**Proposal:** require exact approved/allow outcomes, validate the whole discriminated result before event emission or execution, and treat malformed results as classified evaluation failures. Share validation conventions and primitive schemas, while keeping phase-specific validators. Preserve the explicitly supported `void` interceptor no-op; do not accidentally turn it into a mandatory return.

Do not trust TypeScript alone at extension boundaries: JavaScript consumers, external adapters, casts, and runtime service responses remain possible.

### 2. Use one safe evidence contract across decisions

The motivating `reasonCode` guidance is sensible, but it does not hold consistently across the stack:

- Guardrails accept a bounded snake-case reason code and put it in spans/metrics/logs: [rails.ts](../packages/harness-guardrails/src/rails.ts#L365).
- Generic interception accepts a free-form `reason` and uses it as an error message: [interception type](../packages/harness/src/harness/defineHarness.ts#L628), [error construction](../packages/harness/src/agents/index.ts#L499).
- Governance accepts `message`, `reason`, tags, and arbitrary metadata: [GovernanceDecision](../packages/harness/src/harness/defineHarness.ts#L718).
- Policy and approval reasons/messages are copied into persisted event projections: [sessions.ts](../packages/harness/src/sessions/index.ts#L2871), especially lines 2882 and 2926.
- Attached rails discard their specific reason and rail ID when returning a block: [rails.ts](../packages/harness-guardrails/src/rails.ts#L179). Standalone retrieval instead returns `GUARDRAIL_BLOCKED` with rail/phase/reason metadata at line 144.

Thus the same logical rail block is diagnosable through one entry point but generic through another. A caller cannot reliably select a safe user-facing fallback without consulting telemetry. Conversely, governance's free-form fields create a route for application-derived content into otherwise content-minimized events.

**Proposal:** define a core safe evidence structure, reused by interception, governance, approval, and event projection. It should carry source identity/version, reason code, and correlation identifiers. Preserve the evidence when crossing the addon/core boundary. Keep fixed framework error messages and let the application map reason codes to localized user text.

Separate three channels explicitly:

1. **Evaluation context:** may contain input; available only to the necessary callback.
2. **Operational evidence:** bounded codes and identifiers; eligible for events/logging.
3. **Review presentation:** sensitive descriptions, comments, and reviewer details; application-owned storage/UI.

A regex cannot prove a string is content-free or low-cardinality. Prefer deployment-defined reason catalogs where practical, validate membership when configured, and never turn arbitrary prose into a code by replacing spaces. Keep run/call/decision IDs out of metric labels even when safe to include in traces. Reviewer references also require application privacy policy.

### 3. Share bounded callback execution, preserving distinct budgets

Evidence:

- Approval is raced against a tool timeout, but the generated signal is discarded before calling the provider: [agents.ts](../packages/harness/src/agents/index.ts#L981); the public [request type](../packages/harness/src/harness/defineHarness.ts#L816) has no signal.
- Native predicates, external evaluators, exposure predicates, and audit sinks are awaited directly: [agents.ts](../packages/harness/src/agents/index.ts#L675), lines 929, 1044, and 1081.
- The core already has [withAbortSignal](../packages/harness/src/runtime/abort.ts#L17), a separate [withToolSignal](../packages/harness/src/agents/index.ts#L1154), and the addon has another timer/abort race in [evaluateAction](../packages/harness-guardrails/src/rails.ts#L389).

A probe held a policy evaluator pending, cancelled the run, and observed that the invocation stayed pending until the evaluator was released. No tool execution was needed to demonstrate the lifecycle gap.

**Proposal:** extract a small bounded-operation primitive that handles parent cancellation, child signal, timeout classification, timer/listener cleanup, and suppression of late results. Use it for hooks, governance, approvals, and audit delivery according to their approved contracts. Expose a narrow supported core seam if the addon needs it; do not use deep imports.

Share the implementation, not necessarily a single timeout value. Decide whether policy, approval, and tool execution consume one total deadline or explicit sub-budgets. The current repeated tool-timeout wrappers should not be silently reinterpreted during refactoring. Preserve the difference between a guardrail action timeout, a tool timeout, and caller cancellation.

Cancellation can stop waiting and prevent continuation; it cannot undo work performed by a callback that ignores its signal. Document that limitation. Approval completion events should represent rejection, timeout, cancellation, and adapter failure consistently, without leaving a requested event unexplained when the runtime can record the outcome.

### 4. Repair the durable review example before promoting reuse

Evidence:

- [payment-review.ts](../examples/durable-human-review/src/payment-review.ts#L56) consumes approval before the durable execution step.
- [review-task-store.ts](../examples/durable-human-review/src/review-task-store.ts#L86) accepts only `approved`, then changes it to `consumed`.
- [steps.ts](../packages/harness/src/runtime/steps.ts#L103) executes the callback before checkpoint commit at line 123.

A probe reproduced: wait → approval → transient executor failure → retry → `not_approved`, with the task stuck `consumed`.

**Proposal:** make the application's approval claim and execution receipt idempotent for the same execution identity and exact action descriptor. Validate/claim inside the durable execution operation. Prefer a transactional domain command or an explicit recovery protocol around the idempotent external effect.

Moving `consumeApproved` inside `ctx.step` alone is insufficient: a failure after consumption but before checkpoint still recreates the problem. Checkpointing consumption separately is also not a substitute for execution-time reauthorization and action binding.

Keep this in the application reference pattern. Do not move payment/review business state into HarnessStorage or turn the synchronous approval provider into a durable human-task runtime.

### 5. Establish explicit proposed-versus-effective tool input

Evidence:

- The assistant's original tool calls enter the emitted transcript and next model request before execution: [agents.ts](../packages/harness/src/agents/index.ts#L411).
- Tool-input interception replaces only a local `input`: [agents.ts](../packages/harness/src/agents/index.ts#L794).
- The transformed input is parsed, checked by governance, and passed to the TypeScript handler: [agents.ts](../packages/harness/src/agents/index.ts#L829).

A probe confirmed all four properties: governance receives the masked value; the handler receives it; model replay contains the original; persisted conversation history contains the original.

This is not evidence that masked content leaks into the persisted operational events, which separately redact tool input. It is a transcript/provenance issue and limits what a tool-input privacy rail guarantees.

**Proposal:** use one internal prepared invocation carrying canonical tool identity, proposed input, validated effective input, and decision evidence. Permissions/policy/approval/execution must refer to the appropriate explicitly named representation. Approval binds the effective action after all input transformations and schema normalization; no mutation may follow without invalidating/rechecking the approval.

Specify which representation appears in conversation history and model continuation. For privacy transforms, do not retain the original merely as a convenient duplicate. Provider-specific opaque round-trip items require separate compatibility tests; rewriting arguments must not corrupt provider continuation state. If some originals must remain, document that limitation and offer blocking rather than a false promise of redaction.

### 6. Reuse strict safe projections for durable waits too

Evidence:

- [validateExternalWaitRequest](../packages/harness/src/storage/external-wait.ts#L78) iterates supplied fields rather than requiring an exact shape.
- [The workflow facade](../packages/harness/src/sessions/index.ts#L1679) uses request values in telemetry before calling storage validation.
- [In-memory registration](../packages/harness/src/storage/in-memory.ts#L354) spreads request fields into stored state.
- [SQLite registration](../packages/harness/src/storage/sqlite.ts#L468) initially returns the spread request, while later reads reconstruct database columns.

Validator probes accepted a deadline-only object and an extra identifier-shaped field. This creates both boundary weakness and adapter differences.

**Proposal:** parse and project the exact documented request before telemetry or persistence. Reuse the same safe projection and validation between facade and storage adapters; test initial and reloaded snapshots for equivalence. Apply the same approach to terminal signals. Shared identifier helpers are appropriate; sharing all decision state machines is not.

### 7. Make output phase semantics usable for agents with tools

[Guardrails.applyOutput](../packages/harness-guardrails/src/rails.ts#L165) runs on every provider response and passes only `response.object ?? null`. [Built-in string privacy actions](../packages/harness-guardrails/src/sensitive-data.ts#L127) reject non-strings. The default loop processes that hook before tool dispatch at [agents.ts](../packages/harness/src/agents/index.ts#L381).

A probe using the handbook's string-output validation pattern terminated on an intermediate `{}` tool-call response before executing any tool. This follows the current every-response hook semantics; it is a composition/DX problem, not an accidental change in execution order.

**Proposal:** distinguish final user-visible output from intermediate model responses. Keep generic `afterModel` interception for full responses, and define explicit addon behavior for final output versus intermediate content. Do not simply skip every response containing tool calls: mixed text/tool responses also require a stated coverage contract.

Expose sufficient phase/response context for actions and compile unsupported bindings early. Add one combined example with output privacy, tool-input transformation, governance approval, and a multi-step provider response.

### 8. Reuse types where semantics match; strengthen correlation elsewhere

Three concrete opportunities:

**Guardrails:** [GuardrailAction](../packages/harness-guardrails/src/rails.ts#L54) always receives `JsonValue` and returns an outcome containing every target. `mayTransform: false` is enforced only at runtime. Introduce phase/value-aware types and a non-transforming result subtype. Retain runtime checks because YAML and adapters remain dynamic. Do not add a new public builder just to obtain inference.

**Multi-tool governance:** [NativePolicyRule](../packages/harness/src/harness/defineHarness.ts#L798) is a union of single-tool rules, while the helper at line 868 permits an inferred union of tool IDs. [GovernanceContext](../packages/harness/src/harness/defineHarness.ts#L701) does not correlate the tool ID and its input as a discriminated union. A compiler probe found that a rule targeting two differently typed tools is rejected when placed in native rules, and narrowing `toolId` does not narrow `input`. Model the context distributively and support multi-target rule storage without casts. Extend the existing type-test suite with both positive and negative cases.

**Durable waits:** [WorkflowContext.wait](../packages/harness/src/harness/defineHarness.ts#L892) returns a snapshot allowing `waiting`, although [the facade](../packages/harness/src/sessions/index.ts#L1700) throws for that status. Return a terminal snapshot type; preserve the wider snapshot type for storage. Reuse exported `ExternalWaitOutcome` instead of repeating it in [the review store](../examples/durable-human-review/src/review-task-store.ts#L4). Do not add durable outcomes to immediate approval responses.

### 9. Give every decision a correctly scoped identity

Exposure IDs are built using run/step/policy/rule/index, omitting the tool: [agents.ts](../packages/harness/src/agents/index.ts#L687), also line 703. A two-tool probe emitted two exposure decisions with one unique decision ID.

**Proposal:** centralize identity construction around the actual occurrence: run, agent/delegation invocation, phase/step, tool or call, policy/rail, and decision position as applicable. Use collision-resistant encoding rather than lossy sanitization where identifiers must remain distinct. Version the identity scheme if downstream systems use IDs as durable audit/deduplication keys. Keep these identities out of metric dimensions.

## Target maintenance structure

Extract by responsibility from `agents/index.ts` and the builder type module, maintaining existing public re-exports:

| Shared core primitive | Consumers | Not its responsibility |
| --- | --- | --- |
| Safe decision evidence and projection | Interceptors, governance, approvals, operational events | Raw input, UI text, review comments |
| Bounded callback execution | Hooks, policy adapters, approval, audit; addon through supported seam | Human review persistence or forced cancellation of external work |
| JSON/identifier/code validation conventions | Extension results, waits, event projection | Authorizing an action or proving content is non-sensitive |
| Invocation identity/context | Tool execution, governance, approval, trace/event correlation | Copying input into telemetry |
| Prepared tool invocation | Canonicalization, transforms, validation, permission/policy/approval, execution | Replacing domain authorization |
| Exact result subtypes | Phase-specific actions, multi-tool contexts, terminal waits | One giant union for all decisions |

Keep reducers separate: rails run sequentially with observable transforms; governance combines effects with `deny > require_approval > audit > allow`; exposure combines visibility rules; durable waits transition through persisted terminal states. A generic reducer would hide these important differences.

Existing core model calls, errors, telemetry, storage, checkpoints, and builder inference remain the foundations. There is no justification here for a new provider runtime, new persistence adapter family, new safety package dependency graph, or a top-level configuration replacement.

## Target developer experience

The user should make three choices, each once:

1. Attach content rails to the default-loop agent.
2. Declare typed tool policies and bind an immediate approval provider if needed.
3. Use an application-owned durable workflow only when the decision must survive the current invocation.

Preserve `.agents(... rails.attach(agent(...)))` and `.governance(({ native, rule }) => ...)`. Improve their contracts instead of adding competing `safety`, `guard`, and `approval` builders.

Proposed API direction, **not current runnable API**:

```ts
// Existing composition stays; reasonCode and approval context are proposed.
.governance(({ native, rule }) => ({
  policies: [native({
    id: 'transfer_policy',
    rules: [rule({
      id: 'large_transfer',
      tools: ['transfer_funds'],
      effect: 'require_approval',
      reasonCode: 'transfer_limit_requires_review',
      when: ({ input }) => input.amount > approvalLimit,
    })],
  })],
  approval: {
    request: (request, { signal }) =>
      applicationApproval.decide(request.subject, { signal }),
  },
}))
```

The proposed subject must describe the effective operation, either through typed ephemeral input or an application-owned action reference. Today [GovernanceApprovalRequest](../packages/harness/src/harness/defineHarness.ts#L816) supplies IDs, decisions, and metadata, but no typed input or explicit action subject. Integrators otherwise have to invent side channels or put review data in policy metadata. Typed callback input and persisted evidence must remain separate; adding input to the callback must never imply serializing it into approval events.

Use one immediate approval adapter implementation behind the simple built-in permission path and governance where useful, but preserve coarse permission precedence. Keep existing callbacks as compatibility facades if a migration requires them. Do not automatically ask twice for the same decision, cache a blanket tool grant, or let an approval override a permission/policy denial.

For application durable review, use the existing pattern:

```text
versioned proposal → persisted application review → authorized CAS decision
→ existing storage signal → workflow resume → reauthorize and bind action
→ idempotent domain execution and receipt
```

The existing guardrails guide's [approve-transfer example](../docs/guides/guardrails.md#L461) should be renamed or explicitly explained: returning `block` with `approval_required` stops the run; it does not request approval or suspend durably. Add one decision table and one integrated example across the handbook, package docs, and skill. Do not teach parallel approval implementations in separate chapters.

## Delivery order and acceptance criteria

This is sequencing guidance for selecting subsequent implementation plans, not authorization to change the specs or API.

1. **Characterize and close correctness gaps.** Exact result validation, malformed configuration, cancellable callbacks, approval completion paths, duplicate decision IDs, strict wait projection, and retry-safe review execution. Keep the public architecture unchanged.
2. **Approve the common contracts.** Safe evidence/reason codes, transient versus persisted context, typed approval subjects, budget ownership, and error mapping. Update relevant active specs before implementation.
3. **Extract the shared implementation.** Keep re-exports stable, preserve reducer semantics, and add phase/multi-tool/terminal typing. Address transform provenance and output coverage under explicitly approved contracts.
4. **Make the composition obvious.** Update one integrated runnable example and align docs/skills. Remove misleading competing recipes. Run knowledge/skill audits when those files change.

Minimum regression matrix, extending existing tests rather than creating a separate safety test framework:

- Exact allow/deny/approved/rejected; malformed, missing, unexpected, and thrown results.
- Transforms before policy and approval; transformed input schema failure; no approval can bypass an earlier denial.
- Deny precedence; shadow mode performs no approval or effect enforcement.
- Shared reason/source evidence across attached rails, retrieval, governance, and serialized errors; synthetic content absent from all safe projections.
- Timeouts/cancellation before and during callbacks; late approval cannot execute; timers/listeners cleaned up.
- Tool-input privacy transformation in handler, policy, approval subject, transcript, and provider continuation.
- Final string output plus intermediate and mixed tool responses.
- Two tools and two delegated agent invocations have distinct decision identities.
- Durable review failure before effect, after effect/before checkpoint, and after checkpoint/before workflow completion; changed/expired approvals fail closed.
- Type checks reject wrong transform targets, forbidden transforms, and wrong tool fields; multi-tool narrowing works; successful wait results exclude `waiting`.
- Wait adapter registration/readback produces the same exact safe shape.

## Verification and scope

Executed successfully from the `ai-harness` repository:

```sh
npm test --workspace @purista/harness -- test/agent-interceptors.test.ts test/governance.test.ts test/durable-external-wait.test.ts
npm test --workspace @purista/harness-guardrails
npm test --workspace @purista/durable-human-review-example
npm test --workspace @purista/bank-governance-example
npm run test:types --workspace @purista/harness
npm run typecheck --workspace @purista/harness-guardrails
```

These focused suites passed **42 tests** (15 core, 20 addon, 3 durable example, 4 governance example), and both typing commands passed. Additional read-only source storage-contract checks passed during the durable audit. In-memory runtime/compiler probes established the counterexamples described above; no regression test files or source fixes were added.

The review inspected active governance/guardrails contracts, runtime execution, public types, relevant storage/wait code, tests, examples, docs, and the corresponding handbook material. It was not a full monorepo, provider, detector-quality, sandbox-isolation, dependency-security, or performance audit. No live provider or external review service was contacted. No full build or full CI claim is made. Existing uncommitted work was preserved.

## Considered and rejected

- **One universal `allow/block/transform/approve/wait` union:** represents invalid operations and conflates authorization with workflow lifecycle.
- **Adding approval to guardrail YAML:** duplicates governance and risks making content policy appear to grant authority.
- **Making approval providers durable by awaiting indefinitely:** bypasses existing wait/checkpoint semantics and does not survive process loss.
- **Core-owned reviewer CRUD/UI/auth:** conflicts with the application ownership model and adds unnecessary product scope.
- **Bulk renaming `deny` to `block` or `effect` to `decision`:** creates migration work without fixing semantics; shared evidence matters more than identical spelling.
- **Parallelizing rails or merging reducers for speed:** changes ordered transform and precedence behavior. No performance evidence justifies it.
- **Copying review stores/digest helpers into core immediately:** the example's recovery defect should be fixed and real reuse established before promoting application mechanics to public infrastructure.

The recommended first implementation selection is result validation, lifecycle/budget handling, safe decision evidence, and durable review recovery. Resolve the shared contracts before the larger transform/output/type refactor.
