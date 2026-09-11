# Wave 10: Clean cut and complete verification

## End-to-End Outcome

All changed consumers and package exports pass no-drift gates. Actor: maintainer and independent reviewer; entry `workspace verification and removal inventory`. Failure and recovery are explicitly tested.

## Implementation Order

TICKET-010 only; implementation depends on TICKET-007; acceptance additionally requires accepted TICKET-008 and TICKET-009. Scanner writes stay isolated to scripts/package metadata while runtime and docs owner tickets finish. Next: completion review. All required consumer gates remain mandatory.

## Slice Strategy

refactor_exception; exact phase gates and source/type/test/behavior order are in the ticket. This boundary is not split into competing type/implementation writers.

## Isolation

write_scope in _scope.yaml; preserve other workstreams. Read-only reviewers may run alongside implementation. No package installation or external effects.

## Status

accepted. Ticket lifecycle and indexes are canonical; see [coordinator evidence](../evidence/TICKET-010.md).

## Operational Path Coverage

PATH-DB-CLEANUP-SUCCESS, PATH-DB-CLEANUP-FAILURE, PATH-DB-CLEANUP-RECOVERY map to the ticket acceptance matrix and approved NFR/runbook. No unowned release or data conversion.
