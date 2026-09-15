# Wave 1: Atomic core boundary

## End-to-End Outcome
Zod, ArkType and Valibot expose exact nested caller/validated types while all public runtime boundaries validate through Standard Schema and model schemas compile at build.
## Implementation Order
Execute TICKET-001 contract, compiler/runtime/projection tests, implementation, verification and handoff.
## Slice Strategy
One buildable refactor exception: types, runtime validation and projection are changed together because no valid intermediate state exists.
## Isolation
No concurrent writer may touch core builder declarations, schema/runtime helpers, lifecycle consumers, package metadata or fixtures.
## Status
TICKET-001 implementation is complete and awaiting independent review; it owns all core traceability.
## Operational Path Coverage
Type, validation and projection success/failure/recovery paths plus dependency/lockfile provenance are mandatory.
