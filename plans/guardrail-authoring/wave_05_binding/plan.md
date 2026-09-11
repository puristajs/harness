# Wave 5: Attach requirements and end-to-end composition preflight

Owns TICKET-005; dependency: TICKET-004. Execute its contract/test/implementation/verification sequence. End in a working public-interface slice with all three acceptance paths and independent review. Release remains blocked until final integration. No parallel writes in this wave.

## End-to-End Outcome

All ticket success, failure and recovery paths pass.

## Implementation Order

Preflight, contracts, tests, implementation, verification, handoff as frozen in the ticket.

## Slice Strategy

One sequential public-interface slice; no partial release.

## Isolation

Only the ticket write scope; no concurrent same-file work.

## Status

Implementation has not started; dependency acceptance gates readiness.

## Operational Path Coverage

Use linked runbook/NFR and all three acceptance paths; no new external service.
