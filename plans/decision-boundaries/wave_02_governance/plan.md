# Wave 2: Single immediate approval and typed policy

## End-to-End Outcome

One approved effective demand executes one tool. Actor: application policy adapter; entry `HarnessBuilder.governance and agent permissions`. Failure and recovery are explicitly tested.

## Implementation Order

TICKET-002 only; depends on TICKET-001. No overlapping writer. Next: TICKET-003.

## Slice Strategy

vertical_slice; exact phase gates and source/type/test/behavior order are in the ticket. This boundary is not split into competing type/implementation writers.

## Isolation

write_scope in _scope.yaml; preserve other workstreams. Read-only reviewers may run alongside implementation. No package installation or external effects.

## Status

accepted. Ticket lifecycle and indexes are canonical; see [coordinator evidence](../evidence/TICKET-002.md). Acceptance requires independent review and complete evidence.

## Operational Path Coverage

PATH-DB-GOVERNANCE-SUCCESS, PATH-DB-GOVERNANCE-FAILURE, PATH-DB-GOVERNANCE-RECOVERY map to the ticket acceptance matrix and approved NFR/runbook. No unowned release or data conversion.
