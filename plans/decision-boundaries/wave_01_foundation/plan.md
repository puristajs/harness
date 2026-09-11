# Wave 1: Shared evidence and bounded decisions

## End-to-End Outcome

Validated evidence and one bounded callback result. Actor: SDK author and addon; entry `createDecisionEvidence and runDecisionOperation`. Failure and recovery are explicitly tested.

## Implementation Order

TICKET-001 only; depends on approved spec. No overlapping writer. Next: TICKET-002.

## Slice Strategy

foundation_exception; exact phase gates and source/type/test/behavior order are in the ticket. This boundary is not split into competing type/implementation writers.

## Isolation

write_scope in _scope.yaml; preserve other workstreams. Read-only reviewers may run alongside implementation. No package installation or external effects.

## Status

ready. Ticket lifecycle and indexes are canonical; accepted requires independent review and complete evidence.

## Operational Path Coverage

PATH-DB-FOUNDATION-SUCCESS, PATH-DB-FOUNDATION-FAILURE, PATH-DB-FOUNDATION-RECOVERY map to the ticket acceptance matrix and approved NFR/runbook. No unowned release or data conversion.
