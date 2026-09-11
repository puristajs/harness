# Wave 9: One current usage journey

## End-to-End Outcome

One example composes content rails immediate approval and durable review ownership. Actor: developer and operator; entry `handbook package docs canonical skills examples`. Failure and recovery are explicitly tested.

## Implementation Order

TICKET-009 only; depends on verified TICKET-002, TICKET-004, TICKET-005 and TICKET-007. No overlapping writer. TICKET-010 scanner implementation proceeds independently; its final acceptance also requires TICKET-008 and TICKET-009. Document verified Harness behavior; Voyage is out of scope.

## Slice Strategy

refactor_exception; exact phase gates and source/type/test/behavior order are in the ticket. This boundary is not split into competing type/implementation writers.

## Isolation

write_scope in _scope.yaml; preserve other workstreams. Read-only reviewers may run alongside implementation. No package installation or external effects.

## Status

accepted. Ticket lifecycle and indexes are canonical; see [coordinator evidence](../evidence/TICKET-009.md). Acceptance requires independent review and complete evidence.

## Operational Path Coverage

PATH-DB-DOCS-SUCCESS, PATH-DB-DOCS-FAILURE, PATH-DB-DOCS-RECOVERY map to the ticket acceptance matrix and approved NFR/runbook. No unowned release or data conversion.
