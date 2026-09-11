# Wave 2: Inline configuration clean cut and file-surface removal

Owns TICKET-002; dependency: TICKET-001. Execute its contract/test/implementation/verification sequence. End in a working public-interface slice with all three acceptance paths and independent review. Release remains blocked until final integration. No parallel writes in this wave.

## End-to-End Outcome

All ticket success, failure and recovery paths pass.

## Implementation Order

Preflight, contracts, tests, implementation, verification, handoff as frozen in the ticket.

## Slice Strategy

One sequential public-interface slice; no partial release.

## Isolation

Only the ticket write scope; no concurrent same-file work.

## Status

The prior accepted configuration slice is superseded. This wave deletes its file
surface and is ready to execute after TICKET-001.

## Operational Path Coverage

Use linked runbook/NFR and all three acceptance paths; no new external service.
