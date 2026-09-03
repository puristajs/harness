# Guardrail authoring and callback inference — implementation plan

**Status:** approved definitions; implementation has not started. Do not execute this plan as part of the analysis task. The owner wants to discuss the proposal before the next implementation round. Voyage is excluded completely.

Start with [analysis](analysis.md), the approved scoped specs at `../../specs/38-guardrail-authoring`, and TICKET-001. Existing spec37 runtime decisions remain authoritative except the specifically superseded action authoring declarations. No legacy, compatibility or migration layer is allowed.

## Execution order

| Ticket | Deliverable | Dependency |
| --- | --- | --- |
| TICKET-001 | Schema-directed native tools and callback inference | none |
| TICKET-002 | Inline configuration clean cut and file-surface removal | TICKET-001 |
| TICKET-003 | Provider-neutral interceptor build preflight | TICKET-002 |
| TICKET-004 | Sound action tokens and schema-bound sensitive codecs | TICKET-003 |
| TICKET-005 | Attach requirements and end-to-end deployment preflight | TICKET-004 |
| TICKET-006 | Harness guides, examples and canonical skill alignment | TICKET-005 |
| TICKET-007 | PURISTA handbook, phase projections and skill reuse | TICKET-006 |
| TICKET-008 | Consumer cut, CI drift gates and final acceptance | TICKET-007 |

Use one implementation agent at a time: core definitions, addon registries and examples overlap. Each ticket contains exact writes/reads, contracts, ordered actions, command metadata, negative tests and acceptance IDs. The controller promotes planned tickets to ready only after dependencies are accepted, updates four indexes and rebinds the plan manifest. No agent chooses public behavior or substitutes a different verifier.

## Clean cut and reuse

The configuration schema, canonical definition interfaces and existing build/decision/runtime helpers remain sole owners. Declaration emit is the only type projection. Remove obsolete public names, file configuration, generated configuration artifacts and raw paths rather than maintaining dual APIs. Mechanical consumer edits are in the inventoried scopes; unrelated dirty work is preserved. Specs and manifests are not implementation scratch space.

## Verification and release

Each ticket has command-level checks; final integration requires fresh build, lint, all tests, existing coverage thresholds, core and addon type suites, contracts/failure/integration, the inline-only clean-break gate, application preflight, real PURISTA consumer checks, package dry-run and website/skills/knowledge gates. No credentials/network/install/publish is implicit. Website documentation work uses existing routes/components and does not add a general renderer. Rendering/copy entity decoding remains out of scope unless separately reproduced and approved.

## Self-Audit

Confirmed findings and rejected alternatives have source evidence in analysis.md and three independent scoped audits. Exact source generic prototypes verified feasibility, with their baseline limitations recorded; no future implementation test result is claimed. All eight requirements/capabilities, 24 paths and 24 acceptance IDs map reciprocally to tickets. Security/privacy/performance/recovery/operations and package artifacts have owners; absent infrastructure/UI/migrations/Voyage are explicitly scoped N/A. Existing fakes are test-only. No implementation fake, stub, compatibility layer, new dependency or unapproved external check is planned. The only unresolved work is executing and independently reviewing the approved tickets in the next phase.
