# TICKET-010 — isolated cleanup checker evidence

Implemented checker slice for coordinator review, not ticket acceptance.
No runtime, documentation, spec, status, capability catalog, or lockfile edits
were made by this slice. Root owns those repairs and final end-to-end gates.

## Preflight

Coordinator authorized isolated checker implementation after T007 acceptance.
Ticket was `in_progress`, with no execution blockers and the reconciled digests:

- Spec: `178d780874d7c411c6007351bb3c50cb92aaaa2f24777787c8ab951895cbec42`.
- Plan: `ae12591a150ab897b1af6d3ca4d4cf48e945a9772ed5fd6c91ea45ea0f02db5e`.

Read CTR-DB-CLEANUP, the ticket, module/file/representation ownership,
AGENTS/implementation guidance, and the ticket-implementation workflow.
Baseline existing package-boundary and consumer fixtures: 21 passed.
Preserved existing unrelated package/catalog/runtime changes.

## Files and reuse

- Added `scripts/check-decision-boundaries.mjs` and its node:test file.
- Extended `scripts/verify-decision-consumers.mjs` and its existing tests.
  `scanRemovedSymbols` remains the sole removed-identifier inventory and AST
  scanner; exported `filesUnder` remains the sole filesystem walker. Its default
  T008 roots and code-only behavior remain unchanged.
- Extended `scripts/package-boundaries.mjs` and existing tests with
  `verifyPublicHarnessImports`; existing manifest/dependency rules remain intact.
- Changed only the `verify:architecture` script in `package.json`.

No generator, full compiler wrapper, second export inventory, runtime schema
mirror, dependency, compatibility mode, or filesystem mutation in the static
checker was introduced. All node fixtures are local and synthetic, created
under the existing ignored `.artifacts/decision-consumers/` directory and
removed by their owning test teardown only.

## Checks and scoped exceptions

The shared scanner covers exact removed identifiers, quoted/computed/
destructured API names, permission definitions/usages including qualified and
wrapped types, active Markdown/MDX and TypeScript `body` documentation templates.
Code comments and unrelated strings remain non-API prose in consumer mode.
Missing required roots fail; installed/generated trees and historical
spec/plan inventories are outside the declared roots.

Negative fixtures require an exact allowlisted test filename and an explicit
comment immediately before one import/export/variable/assertion statement:
`@ts-expect-error decision-boundaries: removed API` or
`decision-boundaries: negative fixture`. A marker cannot exclude an entire
`it`/`test`/`describe` statement, a whole test file, or runtime source. Tests
prove the next unmarked removed API still fails.

The package import gate checks addon/provider packages and the three decision
examples. It rejects relative Core source/dist paths and unpublished package
subpaths across imports, re-exports, dynamic imports, import types and require.
Core `/testing` is allowed for tests/testing helpers and examples, not ordinary
adapter runtime code. Unrelated living-wiki example internals are outside this
decision-refactor source-import scope.

Ownership checks cover decision/governance/rail execution and generic agent
interceptors. Duplicate callback timers, canonical helper/schema definitions,
known duplicate reason-code validation and handwritten addon decision variants
fail. Legitimate tool lifecycle/model timers, signal-only AbortControllers,
approval-ID hashing and unrelated memory-adapter helpers pass.

Removed governance result fields and unsafe evidence/audit fields are checked
only in their named type/schema contexts; the checker does not mirror the
complete allowed schemas or prohibit application metadata/unknown ingress.
Review `consumed` state is scoped to the durable payment-review source, not
English stream documentation or unrelated Voyage business records.

Required decision/governance/tool module presence and public re-export
continuity are checked from the current decision entrypoint. Private leaks are
derived from actual identity/governance/tool module exports and their source
paths, including aliases/wildcards. Full public value-export inventory remains
owned by the existing public API test, not copied into this checker.

## Test-first evidence

Initial new fixtures failed before implementation because the cleanup checker,
source-import verifier and selectable/documentation scanner behavior did not
exist. Further regression assertions were observed red, then repaired:

- Computed/aliased timer APIs and generic-interceptor timer ownership.
- Prototype property names such as `toString` and unrelated memory helpers
  falsely classified as canonical owners.
- Unrelated living-wiki source imports incorrectly included in the scoped gate.
- Qualified/wrapped permission types and spaced permission assignments.
- Wildcard/aliased private helper exports.
- A negative-fixture marker incorrectly excluding an entire test statement.

The scanner fixture explicitly exercises every identifier in the current
removed API contract. Positive exceptions share the same node:test suites.

## Final verification

All commands used installed tools, no network, secrets or dependency changes.

| Command | Result |
| --- | --- |
| `node --test ai-harness/scripts/check-decision-boundaries.test.mjs` | Exit 0; 5 tests |
| `node --test ai-harness/scripts/check-decision-boundaries.test.mjs ai-harness/scripts/package-boundaries.test.mjs ai-harness/scripts/verify-decision-consumers.test.mjs` | Exit 0; 31 tests, no skips |
| `node ai-harness/scripts/check-decision-boundaries.mjs` | Exit 0; real active workspace static scan passes |
| `npm --prefix ai-harness run verify:architecture` | Exit 0; 31 node tests, 2 capability families, real static scan |
| Scoped `git -C ai-harness diff --check -- scripts/check-decision-boundaries.mjs scripts/check-decision-boundaries.test.mjs scripts/verify-decision-consumers.mjs scripts/verify-decision-consumers.test.mjs scripts/package-boundaries.mjs scripts/package-boundaries.test.mjs package.json` | Exit 0 |

The first real scan correctly reported three scoped issues: duplicated reason
validation in addon sensitive-data, a private registry import in an addon test,
and an unmarked negative permission fixture. Root/lifecycle owners repaired
them; this checker slice did not edit those files. The final scan passes.

The consumer fixture's synthetic orchestration output is not real Voyage
integration evidence. The full `CMD-CONSUMERS`, builds, runtime/example suites,
coverage and accepted T008/T009 remain mandatory final T010 acceptance gates.
No global build or full runtime test was run by this isolated slice.

## Limits and handoff

Static checks identify the specified syntactic regressions; arbitrary callback
values, sequencing, effect admission, cancellation and privacy remain proven by
canonical schema/type/runtime tests. No success from this checker waives those
gates or the existing unrelated Voyage compilation blocker. Coordinator owns
independent review, lifecycle updates and final acceptance.
