# TICKET-006 — exact external waits

Recorded implementation and independent review: 2026-08-26.

Added strict request/signal/snapshot schemas and terminal ExternalWaitResolved, shared adapter projection/validation, exact automatic-expiry shape, and injected-clock expiry before signal reduction. Review repaired event ordering: registration and mandatory readback must be validated and match the requested fields before any external_wait event.

Verification recorded: focused waits 119 tests, storage contracts 126 tests, core typecheck/type tests and diff check passed. Adversarial adapter tests prove malformed/foreign readback yields invalid_snapshot with no wait events. Independent re-review passed.

TICKET-007 subsequently exposed a durable run lease race outside the wait snapshot reducer; its bounded integration repair and final whole-tree verification remain required.
