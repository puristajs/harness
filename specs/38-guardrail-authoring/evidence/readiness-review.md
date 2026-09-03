# Definition readiness review — 2026-08-26

Scope: one inline configuration schema, sound action/codec construction, declarative build preflight, native callback/schema inference, public docs/skills/website and clean consumer alignment. The owner later approved removal of the alternate configuration surface; TICKET-002 must be reimplemented before dependent work. Final scoped manifest binds that authority, not an approval inherited from spec37.

Three independent read-only reviewers inspected current source and the proposed contracts: governance/action binding; callback/type inference; documentation/consumers. Root integrated their evidence and walked source contracts, traceability, NFR/operations, reuse/generation and ticket handoff. No reviewer implemented source changes.

## Findings resolved before handoff

| Review | Finding | Resolution |
| --- | --- | --- |
| Action/binding | Invented retrieval/public interceptor names | Retain filterRetrievedChunks and private interceptor |
| Action/binding | Repeated flow IDs conflicted with spec37 identity | Reject duplicate flow IDs |
| Action/binding | Prepared callback could miss action-local signal | Thunk accepts canonical DecisionExecutionContext from the bounded executor |
| Action/binding | Error constructors/overloads incompletely frozen | Exact schemas, constructor, reasons, mappings and four overload cases |
| Action/binding | modelCheckRail ownership split ambiguous | T004 token construction; T005 projection/aggregation; T002 direct aliases |
| Callback | Heterogeneous registry could not satisfy blanket erasure prohibition | Narrow existing runtime-storage exception behind generic construction/CheckedTools |
| Callback | Spread could invalidate schema/handler relationship | Mapped registration check of each entry's own schemas |
| Callback | Model-facing schema projection used wrong side | Explicit input JSON Schema projection and transform-count tests |
| Callback | Missing living-wiki factory and error representation | Exact source scope/factory change and closed error metadata/serialization mapping |
| Docs | Generation repaired stale files before checking | Core compile then addon compile-only/check before full generation |
| Docs | Core verifier guarantee overstated | State actual source-overlay/runtime and separate strict dist smoke guarantees |
| Docs | Missing cards/skill paths and ambiguous scan | Exact paths, post-build snippet check and executable zero-match scan |

Final source verification also retained spec31 required maskToken/scoreThreshold rather than introducing new policy defaults. No remaining semantic decisions are delegated to implementation. The token/helper prototypes and current-source probes establish feasibility; they are not reported as future implementation acceptance. The full-source compiler overlay comparison had unchanged baseline diagnostics, recorded in plan analysis. No clean full-suite claim is made for this planning phase.

## Checklist walk

Core/end-to-end definition, architecture/file structure, contracts/generation, testing, security/abuse, performance/capacity and service topology checklists were read. Applicable controls are covered by contracts, NFRs, runbook, generation/representation catalogs and per-ticket acceptance. The skill index references a secrets/privacy checklist file absent from the installed package; privacy was explicitly walked against the security checklist and spec37 safe evidence requirements for parsed JSON, models/detectors and diagnostics. No privacy item was silently skipped.

Documentation-only website changes preserve existing routes/layout/accessibility; rendered content/projections/copy-input verification is required. No application UI, new service, persistent data, migration, live external dependency, business compliance or Voyage work is included, as scoped in applicability.

No new dependencies or provider behavior are assumed. Current primary docs support contextual typing, Zod projection and the deliberate removal of misleading NeMo metadata. All generators consume canonical runtime schemas and existing toolchains. D0/D1 private implementation decisions only; changed public behavior or new scope requires a newly approved spec/plan.

Deterministic spec/plan checks and workspace knowledge/skill audits are recorded in plan evidence. Approval attests readiness to implement these definitions; all eight tickets still need implementation and independent acceptance.
