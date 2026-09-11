# Wave 2 — Private catalogs and Docker durability correction

## End-to-End Outcome

Provide tested private catalog primitives for existing in-memory and single-host adapters without changing their public port yet.

Implement Docker-private ownership and administrative operations against the existing scripted engine transport.

Provide isolated offline Core verification against the actual local Harness tarball.

## Implementation Order

TICKET-002 after TICKET-001: Private local owner catalog and administration primitives.

TICKET-003 after TICKET-001: Docker-private indexed ownership and purge preparation.

TICKET-014 after TICKET-003: persist the Docker inventory, revocation barriers,
and purge journal in the existing private metadata root. It is deliberately a
small adapter-owned correction, not a Harness catalog import or a new service.

TICKET-013 after TICKET-001: Offline packed Harness/PURISTA verification prerequisite.

## Slice Strategy

Approved foundation exception; direct schema/catalog tests give a working isolated increment, not a release. Next vertical integration is the atomic base-port cutover.

## Isolation

TICKET-002 writes only Harness-private catalog modules; TICKET-003 writes only Docker-private modules; TICKET-013 writes verification scripts/fixtures. TICKET-014 is serial after TICKET-003 because it replaces the latter's process-local journal with durable adapter-private state. All read shared contracts and never edit indexes. Other waves are serial.

## Status

TICKET-002, TICKET-003, and TICKET-013 are historical foundations. TICKET-014 is planned and requires a separate execution request. No runtime integration is claimed.

## Operational Path Coverage

PATH-SOWN-OWNER, PATH-SOWN-ADMIN, PATH-SOWN-BOUNDS, PATH-SOWN-SAFETY, PATH-SOWN-DELIVERY. See canonical failure/recovery and operator proof in 04-verification.md.
