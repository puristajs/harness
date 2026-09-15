# TICKET-006 — Harness guides, examples, and canonical skill alignment

Recorded implementation: 2026-08-26. Status: **implemented; not accepted**.
Independent review controls acceptance and lifecycle promotion.

## Scope and contract trace

Implemented `CTR-GA-DOCS`, `CTR-GA-CLEANUP`, and `REQ-GA-DOCS` only in the
Harness documentation, example guidance, and canonical `ai-harness` skill
scope. No PURISTA website source, Voyage source, runtime implementation, or
installed skill mirror was changed.

- Replaced the obsolete Guardrails guide with one inline TypeScript authoring
  path: opaque `defineGuardrailAction` tokens, phase-correlated flow IDs,
  direct model aliases, explicit tool selection, the native builder-local tool
  helper, sensitive-data codecs, retrieval filtering, build preflight, and
  content-free `reasonCode` guidance.
- Preserved the existing `examples/guardrails` workspace as the runnable source
  of truth. Its checked preflight, two differently shaped tools, selective
  tool rails, model requirement failure, final-output validation, and zero
  protected-effect coverage remain the public executable example.
- Replaced active native TypeScript tool snippets in Harness docs and the
  canonical skill/reference with `.tools(({ tool }) => ({ name: tool(...) }))`.
  Raw native-tool authoring no longer appears in active guidance; the retained
  MCP literal snippets and empty tool maps are not native tool definitions.
- Review repair: guidance now states the exact raw-native failure boundary:
  `.tools(...)` registration, not `build()`. The canonical testing reference
  now covers inline configuration/action correlation, safe configuration
  failures, action outcomes, build preflight, and the runnable composition's
  zero-effect counters. Tool-input and tool-output action guidance requires a
  nonempty selector after the action-contract correction was verified.
- Updated the root and package README package descriptions, ecosystem guide,
  implementation guidance, and canonical skill to describe inline typed
  configuration and direct aliases. The skill has no local mirror target in
  this ticket, so `skills:sync` was intentionally not run.

## Acceptance mapping

| Acceptance ID | Evidence |
| --- | --- |
| `AC-GA-DOCS-SUCCESS` | The guide documents the actual five phase values, target table, ordered build guarantees, direct alias model checks, required tool selectors for tool phases, and inline configuration. The guardrails example test passed. |
| `AC-GA-DOCS-FAILURE` | A scoped residual scan found no obsolete Guardrails configuration names or raw native-tool snippets in active Harness docs, examples, or the canonical skill. The remaining `.tools({ ... })` occurrences are MCP literals or empty maps. |
| `AC-GA-DOCS-RECOVERY` | Full workspace lint/build and the focused example/addon suites passed after the documentation and skill changes. |

## Verification

Commands ran against the current dirty workspace; unrelated existing changes
were preserved.

1. `node /Users/sebastianwessel/.agents/skills/spec-readiness-review/scripts/check_specs.mjs ai-harness/specs/38-guardrail-authoring` — pass.
2. `node /Users/sebastianwessel/.agents/skills/spec-implementation-planner/references/check_plan.mjs . ai-harness/plans/guardrail-authoring ai-harness/specs/38-guardrail-authoring` — pass.
3. `npm --prefix ai-harness run build` — first restricted attempt reached the
   unrelated native-privacy build and was blocked by sandbox `EPERM` while its
   local build tool inspected its process. The approved elevated retry made no
   network request and passed the full workspace build.
4. `npm --prefix ai-harness run lint` — pass.
5. `npm --prefix ai-harness test --workspace @purista/guardrails-example` —
   pass, 8 tests.
6. `npm --prefix ai-harness test --workspace @purista/harness-guardrails` —
   pass, 47 tests.
7. `node ai-harness/scripts/check-decision-boundaries.mjs` — pass.
8. Scoped obsolete-surface and raw-native-tool scans — pass; only unrelated
   `defineTool` prohibition wording, MCP literals, and empty tool maps remain.
9. `git diff --check` — pass.
10. Review-repair verification: `npm --prefix ai-harness test --workspace
    @purista/guardrails-example` — pass, 8 tests;
    `npm --prefix ai-harness run test:types --workspace
    @purista/harness-guardrails` — pass; and
    `node ai-harness/scripts/check-decision-boundaries.mjs` — pass. The
    refreshed scoped scan found no obsolete Guardrails configuration language
    or raw native TypeScript tool snippets; tool-phase selector guidance matches
    the verified action contract.

## Handoff

Ticket implementation is ready for independent review. It is not
self-accepted.
