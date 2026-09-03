# Wave 5: Typed rails and final-only output

## End-to-End Outcome

Input tool and final-output rails compose with governance. Actor: guardrails consumer; entry `Guardrails.attach and filterRetrievedChunks`. Failure and recovery are explicitly tested.

## Implementation Order

TICKET-005 only; depends on TICKET-004. No overlapping writer. Next: TICKET-006.

## Slice Strategy

vertical_slice; exact phase gates and source/type/test/behavior order are in the ticket. This boundary is not split into competing type/implementation writers.

## Isolation

write_scope in _scope.yaml; preserve other workstreams. Read-only reviewers may run alongside implementation. No package installation or external effects.

## Status

accepted. Ticket lifecycle and indexes are canonical; see [coordinator evidence](../evidence/TICKET-005.md). Acceptance requires independent review and complete evidence.

## Operational Path Coverage

PATH-DB-RAILS-SUCCESS, PATH-DB-RAILS-FAILURE, PATH-DB-RAILS-RECOVERY map to the ticket acceptance matrix and approved NFR/runbook. No unowned release or data conversion.
