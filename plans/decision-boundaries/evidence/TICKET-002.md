# TICKET-002 — governance

Initial implementation/reviews: 2026-08-26. **Acceptance reopened by final source audit.**

The initial implementation removed permission `ask`/`onPermission`, added strict callback types and one immediate approval path, and moved governance into its own module. Review repairs added terminal error propagation, exact boolean predicates, closed permission/exposure rules, correlated selectors, and approval subjects. Initial core build/typecheck/type tests, 41 focused tests, and bank tests/typecheck passed.

The later `governance_final_audit` found uncovered contract defects in per-callback budgets, adapter decision ordinals/IDs, enforced demand attribution, approval failure projection, denial evidence, reserved identifiers, and recursive permission patterns. In particular a nested path bypassed `deny: ['docs/**']`. Earlier passing tests are insufficient to accept this ticket. The coordinator has set it to `partial`; targeted repair and independent re-review are required.

## Independent final repair review — 2026-08-26

The consumer implementation agent independently inspected the repaired `governance/index.ts`, shared decision executor/schema/identity, governance builder validation, denial error constructors, tool preflight controller wiring, and the corresponding regression assertions. It made no governance source changes. The eight reviewed defect groups are:

1. Recursive permission matching: `*` is segment-local; `**` matches nested paths, with deny before allow for bash/write/edit.
2. Callback timing: native, adapter, exposure, audit and approval callbacks each get a fresh shared-executor child budget; public deadline reports the parent minimum, and tool/run parent abort reasons retain priority. Late approval cannot reach a handler.
3. Ordinals and identity: native invocation/adapter abstention reserve positions; arrays reserve consecutive positions; synthetic defaults follow evaluated positions; source identity and approval hashes use the declared tuples.
4. Restriction attribution: the linear reducer preserves declaration ordering, marks each contributing restriction, suppresses approval demands under deny, and leaves coarse permission approval enforced in shadow/disabled governance.
5. Approval exit events: success, rejection, invalid output, callback failure, timeout and cancellation attempt one terminal event after requested emission; delivery failure is not retried and does not replace original cancellation/failure.
6. Audit failure: thrown failure and own timeout use `audit_failed` with the failing record's validated evidence, without inspected input/metadata.
7. Recoverable denial projection: permission/policy/approval rejection use fixed messages and exact safe evidence metadata, validate constructor inputs, and omit sensitive sentinels.
8. Configuration and callback validation: closed result/config shapes, actual-undefined abstention, exact boolean predicates, reserved/duplicate identities, and required static approval providers are covered by the repaired validation/tests.

Independent command: `npm --prefix ai-harness test --workspace @purista/harness -- test/governance.test.ts` passed **83/83** tests. No confirmed additional blocker was found in this review. Two considered configuration cases are not change requests: the approved static native approval provider requirement applies in enforce mode even when evaluation is disabled; an exposure object without rules is not one of the stated nonempty configuration alternatives. No relaxation was introduced.

Limits: this is a focused governance source/test review, not proof of the remaining consumer/full-build/docs gates. The coordinator owns ticket acceptance and lifecycle/index updates; this appendix does not self-accept TICKET-002.

## Final documentation-driven repair and independent recheck

The documentation composition exposed TS7006 for inline approval callbacks. The repair uses one GovernanceApprovalProvider<S> contract, a contravariant request property and distributive canonical request/provider aliases. No fallback union, casts or bivariant workaround remains. Positive inline/object/helper and standalone provider assignments, correlated multi-tool input and negative wrong-field/unsafe-provider assertions pass. Root independently inspected the actual signature/type tests and reran core type tests (exit0); fresh core build passed. Agent focused governance/interceptor132 tests and core typecheck passed. Acceptance restored.
