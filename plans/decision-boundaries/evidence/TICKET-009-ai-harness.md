# TICKET-009 — Harness documentation and composed example

## Scope and ownership

Implemented the Harness-only portion of the ready T009 ticket. The coordinator
owns builds, global audits, prerequisite lifecycle, final acceptance, and merged
T009 evidence. The consumer writer owns PURISTA handbook/skills/mirrors and
Voyage alignment. No runtime, package manifest, dependency, lockfile, approved
spec, or plan lifecycle file was changed by this documentation slice.

Existing unrelated dirty work was preserved, including sandbox documentation,
skill references, package READMEs, and the preceding durable-review example work.

## Changes

- Added `docs/guides/decisions-and-approval.md`: one current decision table,
  canonical batch lifecycle, parsed/wire distinction, shared approval provider,
  safe evidence, callback budgets, model accounting, claim/receipt recovery,
  direct-call/opaque-reasoning limits, and no post-admission revocation.
- Added `examples/guardrails/README.md` and extended its existing source/tests.
  The same fake-provider composition covers input allow/block/transform,
  tool-input and tool-output transforms, final-output transformation, two
  TypeScript tools with correlated multi-tool policy narrowing, and builtin
  write approval combining static permission and policy demands. One provider
  receives both kinds of immediate approval request. No dependency was added.
- Updated root `README.md`, `docs/README.md`, core/guardrails/OpenAI package
  READMEs, focused bank/review READMEs, public API reference, and existing
  configuration/guardrails/extending/human-review/security guides.
- Updated canonical Harness skill main instructions and references for
  agents/workflows/tools, configuration, storage/streaming/errors, durable
  feedback/operations, and telemetry. No installed user skill was modified.
- Corrected only affected package ownership inventory in `.agent/IMPLEMENTATION.md`.
- Added exact `.artifacts/decision-skills/` ignore entry and generated the
  mirror at `.artifacts/decision-skills/ai-harness` using the existing sync script.
- Removed obsolete `docs/guides/migrating-to-v2.md` and `migrating-to-v3.md`
  after confirming neither had an existing diff. Retained their unique current
  MCP transport/dependency requirements in `mcp-tools.md` and SQLite schema
  readiness in `durable-workspaces.md`; removed inbound links including the
  agent-plugin guide. Added current breaking-contract notes at
  `docs/releases/decision-boundaries.md`, not a replacement migration recipe.

## Test-first and contract proof

The initial six composed-example tests failed before behavior changes: existing
output differed and `createGuardrailsExample` did not exist. A seventh content
block test was then added and failed because the run reached the provider;
the input block action made it pass. The final runtime suite proves:

1. Credential-free execution produces the transformed final answer.
2. Both custom-policy and builtin permission/policy demands use one provider;
   write carries both demand kinds in one request.
3. Approval sees the schema-defaulted parsed note, preflight visits every call
   before dispatch, and publishing follows its own approval.
4. Input markers never reach the first provider request; private tool result
   presentation is removed before the second request.
5. Rejection prevents publication and becomes a recoverable tool denial.
6. Thrown approval callbacks and own callback timeout fail closed without
   publishing or leaking raw reviewer exception text; cancellation also prevents
   publication. Independent siblings may already execute: no transaction or
   rollback assertion is made.
7. Content block produces rail-owned `DecisionBlockedError` evidence with no
   model, approval, or publication call.

Public snippet provenance is the runnable composed source, existing bank/review
examples, and core/addon type tests. Prose links to the composition instead of
copying another untested application. Temporary callback annotations were
removed after the core owner repaired inline approval inference.

## Verification completed

All commands used installed dependencies and no network or credentials.

| Command | Result |
| --- | --- |
| `npm test --workspace @purista/guardrails-example` | PASS, 7 tests |
| `npm run typecheck --workspace @purista/guardrails-example` | PASS after refreshed addon declarations; independently rerun at 15:07 |
| `npm test --workspace @purista/bank-governance-example` | PASS, 4 tests |
| `npm run typecheck --workspace @purista/bank-governance-example` | PASS |
| `npm test --workspace @purista/durable-human-review-example` | PASS, 12 tests |
| `npm run typecheck --workspace @purista/durable-human-review-example` | PASS |
| `node ai-harness/scripts/sync-ai-harness-skill.mjs ai-harness/.artifacts/decision-skills/ai-harness` | PASS |
| Same script with `--check` before the exact target | PASS, mirror current |
| `check_specs.mjs ai-harness/specs/37-decision-boundaries` | PASS |
| `check_plan.mjs . ai-harness/plans/decision-boundaries ai-harness/specs/37-decision-boundaries` | PASS |
| `git diff --check` in Harness | PASS |
| Read-only local Markdown target check across 19 changed documents | PASS |
| Active docs/skills/README/example scan for removed decision APIs and migration-page links | Empty |

## Inference regression resolution

The example exposed TS7031 for natural
`rails.attach({ input: z.string(), instructions: ({ input }) => ... })` after
the first generic attachment repair. The coordinator reopened that addon ticket
and its owner added raw-literal and helper-composition type regressions. The
final refreshed addon declarations pass the exact unchanged example at 15:07;
both typecheck and all seven runtime tests were independently rerun here.
There is no callback annotation, cast, state extraction, or alternate builder
workaround in the example.

## Outstanding coordinator gates

Package builds and global core type tests/PURISTA audits remain coordinator
gates by ownership; their results are not claimed here. This slice does not
claim the unrelated Voyage compilation blocker is resolved. Lifecycle
recommendation: implemented; acceptance pending coordinator-owned checks and
independent review. No remaining Harness-only documentation/example blocker.
