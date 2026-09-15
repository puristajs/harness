# Wave 4: Provider conformance

## End-to-End Outcome
All first-party adapters pass distinctive JSON schemas unchanged and map provider rejection without weakening retries.
## Implementation Order
Promote and execute TICKET-004 after core projection acceptance.
## Slice Strategy
One adapter-conformance slice across four package seams; no core contract changes.
## Isolation
Provider package writes are exclusive within this wave.
## Status
Implementation is complete and awaiting independent review.
## Operational Path Coverage
Pass-through success, explicit rejection and compatible-schema recovery use fakes only.
