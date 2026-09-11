# Wave 7: Retry-safe application approval claim

## End-to-End Outcome

Approved action records one admitted execution and receipt. Actor: application reviewer and worker; entry `reviewPayment workflow and ReviewTaskStore`. Failure and recovery are explicitly tested.

## Implementation Order

TICKET-007 only; depends on TICKET-006. No overlapping writer. Next: TICKET-008.

## Slice Strategy

vertical_slice; exact phase gates and source/type/test/behavior order are in the ticket. This boundary is not split into competing type/implementation writers.

## Isolation

write_scope in _scope.yaml; preserve other workstreams. Read-only reviewers may run alongside implementation. No package installation or external effects.

## Status

accepted. Ticket lifecycle and indexes are canonical; see [coordinator evidence](../evidence/TICKET-007.md). Acceptance requires independent review and complete evidence.

## Operational Path Coverage

PATH-DB-REVIEW-SUCCESS, PATH-DB-REVIEW-FAILURE, PATH-DB-REVIEW-RECOVERY map to the ticket acceptance matrix and approved NFR/runbook. No unowned release or data conversion.
