# Wave 4: Prepared tool batch and content lifecycle

## End-to-End Outcome

Preflight produces one effective call for history and model replay. Actor: default-loop agent caller; entry `runDefaultAgent tool dispatch and final output`. Failure and recovery are explicitly tested.

## Implementation Order

TICKET-004 only; depends on TICKET-003. No overlapping writer. Next: TICKET-005.

## Slice Strategy

refactor_exception; exact phase gates and source/type/test/behavior order are in the ticket. This boundary is not split into competing type/implementation writers.

## Isolation

write_scope in _scope.yaml; preserve other workstreams. Read-only reviewers may run alongside implementation. No package installation or external effects.

## Status

accepted. Ticket lifecycle and indexes are canonical; see [coordinator evidence](../evidence/TICKET-004.md). Acceptance requires independent review and complete evidence.

## Operational Path Coverage

PATH-DB-TOOLS-SUCCESS, PATH-DB-TOOLS-FAILURE, PATH-DB-TOOLS-RECOVERY map to the ticket acceptance matrix and approved NFR/runbook. No unowned release or data conversion.
