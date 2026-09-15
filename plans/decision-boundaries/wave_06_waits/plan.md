# Wave 6: Strict wait schemas and terminal return

## End-to-End Outcome

Registration readback and terminal results use exact canonical shape. Actor: durable workflow and storage adapter; entry `externalWait.wait registerWait signalWait`. Failure and recovery are explicitly tested.

## Implementation Order

TICKET-006 only; depends on TICKET-005. No overlapping writer. Next: TICKET-007.

## Slice Strategy

vertical_slice; exact phase gates and source/type/test/behavior order are in the ticket. This boundary is not split into competing type/implementation writers.

## Isolation

write_scope in _scope.yaml; preserve other workstreams. Read-only reviewers may run alongside implementation. No package installation or external effects.

## Status

accepted. Ticket lifecycle and indexes are canonical; see [coordinator evidence](../evidence/TICKET-006.md). Acceptance requires independent review and complete evidence.

## Operational Path Coverage

PATH-DB-WAITS-SUCCESS, PATH-DB-WAITS-FAILURE, PATH-DB-WAITS-RECOVERY map to the ticket acceptance matrix and approved NFR/runbook. No unowned release or data conversion.
