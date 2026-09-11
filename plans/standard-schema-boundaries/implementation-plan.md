# Standard Schema boundaries — implementation plan

**Status:** approved definitions; TICKET-001 is in progress. TICKET-002 and TICKET-003 are retained as skipped history because their split was proven non-buildable when the public generic was removed.

The source of truth is `../../specs/39-standard-schema-boundaries` at its approved manifest digest. Execute tickets in order. Do not add compatibility, migration, vendor-dispatch, schema-rewrite, or placeholder paths.

## Execution order

| Ticket | Deliverable | Dependency |
| --- | --- | --- |
| TICKET-001 | Atomic core: public types, runtime validation, projection cache and memory-summary fix | none |
| TICKET-002 | Historical validation slice; superseded before execution | TICKET-001 |
| TICKET-003 | Historical projection slice; superseded before execution | TICKET-002 |
| TICKET-004 | First-party provider exact pass-through conformance | TICKET-001 |
| TICKET-005 | Harness/PURISTA docs, examples, skills and website | TICKET-004 |
| TICKET-006 | Legacy removal gates, full CI and breaking release evidence | TICKET-005 |

The type contract, runtime validator and projection cache form one indivisible refactor exception: removing the old type constraints makes the old Zod calls ill-typed, while the new projection cache is required before default-loop code can construct model requests. TICKET-001 therefore owns all nine core paths and acceptance rows. Later tickets remain sequential. Each executable ticket starts with spec/plan/status preflight, writes only its declared scope, proves success/failure/recovery, and ends in review-ready evidence. The controller updates lifecycle indexes and rebinds the plan manifest after each transition.

## Clean cut

TICKET-001 removes the public Zod generic contract instead of wrapping it and installs the one validation helper and one projection helper in the same atomic change. Internal Zod remains outside public user-schema paths. Later tickets may delete stale code but may not broaden scope into Voyage, framework migrations, or provider normalization.

## Verification and release

All verification is local and secret-free. Provider tests capture SDK requests rather than calling networks. Dependency acquisition in TICKET-001 is limited to the exact approved versions and may require normal sandbox/network approval; it is an implementation prerequisite, not a design choice. Final acceptance includes Harness full CI, provider packages, examples, docs/site builds, skill/knowledge audits, forbidden source scans, and a package dry run without publishing.

## Self-Audit

All six requirements, six capabilities, eighteen end-to-end paths, and eighteen acceptance IDs map exactly once to a non-skipped ticket. The nine core entries map to TICKET-001; TICKET-002 and TICKET-003 have empty traceability by design and remain only as recorded superseded slices. Cross-ticket dependencies match the buildable source order. Tests precede implementation within each ticket. Error privacy, async cancellation, JSON integrity, cache bounds, provider rejection, consumer regeneration, rollback, and supply-chain checks have named owners. No future test result, independent review, or implementation is claimed. Open decisions: none.
