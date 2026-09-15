# Wave 8: PURISTA and workspace integration

## End-to-End Outcome

New public contracts forward through Core with no provider dependency. Actor: PURISTA service and app author; entry `AgentQueueBuilder executor and SSE projection`. Failure and recovery are explicitly tested.

## Implementation Order

TICKET-008 only; depends on TICKET-007. No overlapping writer. Converges with TICKET-009 at TICKET-010. It verifies in-scope Core and starter/create-purista consumers; Voyage is excluded.

## Slice Strategy

vertical_slice; exact phase gates and source/type/test/behavior order are in the ticket. This boundary is not split into competing type/implementation writers.

## Isolation

write_scope in _scope.yaml; preserve other workstreams. Read-only reviewers may run alongside implementation. No package installation or external effects.

## Status

accepted. Ticket lifecycle and indexes are canonical; see [coordinator evidence](../evidence/TICKET-008.md).

## Operational Path Coverage

PATH-DB-CONSUMERS-SUCCESS, PATH-DB-CONSUMERS-FAILURE, PATH-DB-CONSUMERS-RECOVERY map to the ticket acceptance matrix and approved NFR/runbook. No unowned release or data conversion.
