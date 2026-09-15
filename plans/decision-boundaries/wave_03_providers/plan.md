# Wave 3: Canonical provider continuation

## End-to-End Outcome

Synthetic reasoning survives and transformed wire arguments are sent. Actor: provider adapter; entry `ModelProvider response and subsequent request mapper`. Failure and recovery are explicitly tested.

## Implementation Order

TICKET-003 only; depends on TICKET-002. No overlapping writer. Next: TICKET-004.

## Slice Strategy

refactor_exception; exact phase gates and source/type/test/behavior order are in the ticket. This boundary is not split into competing type/implementation writers.

## Isolation

write_scope in _scope.yaml; preserve other workstreams. Read-only reviewers may run alongside implementation. No package installation or external effects.

## Status

accepted. Ticket lifecycle and indexes are canonical; see [coordinator evidence](../evidence/TICKET-003.md). Acceptance requires independent review and complete evidence.

## Operational Path Coverage

PATH-DB-PROVIDERS-SUCCESS, PATH-DB-PROVIDERS-FAILURE, PATH-DB-PROVIDERS-RECOVERY map to the ticket acceptance matrix and approved NFR/runbook. No unowned release or data conversion.
