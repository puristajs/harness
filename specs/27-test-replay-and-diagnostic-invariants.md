# Test replay and diagnostic invariants

**Status:** human-approved follow-up scope. This specification adds opt-in
test utilities and developer-only diagnostics; it creates no production
recording service or runtime policy engine.

## Purpose and scope

Provider behavior and complex agent loops are costly to reproduce. The testing
entrypoint SHALL offer sanitized, deterministic model-interaction recording and
strict replay. The harness SHALL also offer opt-in diagnostic invariants for
configuration and run behavior while preserving normal production cost and
privacy characteristics.

Both features live under `@purista/harness/testing` or explicit development
options. They are disabled by default and do not write to `HarnessStorage`,
persisted events, memory, workspaces, checkpoints, telemetry payloads, or
production logs.

## Replay contract

The testing entrypoint exports the closed contracts in
[13-public-api.md](./13-public-api.md). A `SanitizedReplayFixture` has
`version: 1`, a caller-owned `id`, and ordered interactions. Each interaction
has a sanitized request fingerprint, method (`text`, `object`, `textStream`,
or `objectStream`), sanitized provider/model labels, and either one sanitized
final outcome or ordered sanitized chunks followed by that outcome. Fixtures
are ordinary caller-owned test data; the harness does not discover, upload,
download, or execute them.

`createReplayInteractionRecorder({ sanitize })` requires an explicit sanitizer
callback and `recorder.wrap(provider)` returns a provider proxy. Each raw
request/response/chunk is passed to `sanitize` before it reaches fixture state;
the utility never serializes the pre-sanitized value. It cannot guarantee that a
caller-provided sanitizer itself removes raw content, so callers own review of
the returned sanitized value. `recorder.fixture(id)` returns the immutable
version-1 fixture. `replayModelProvider(fixture, options)` creates an offline
provider proxy and `assertReplayConsumed(provider)` verifies no interactions
remain. Replaying a fixture must make no network request.

Replay is strict and deterministic:

1. request fingerprint and declared provider/model labels must match;
2. chunks/final outcomes are consumed in the stored order;
3. a mismatch, exhausted fixture, invalid schema version, unsupported method,
   or unused fixture interaction is a `ReplayFixtureError`; and
4. failure metadata contains only test fixture ids, ordinal, and sanitized
   labels, never raw interaction content.

The replay adapter follows the normal `ModelProvider` port and therefore
exercises normal stream ordering, cancellation, and error handling. It is not
a new production transport.

## Diagnostic invariants

`HarnessDiagnosticInvariant` is a development-only callback contract.
`assertDiagnosticInvariants(snapshot, invariants)` is an explicit testing
entrypoint invoked by the caller after inspection and/or a completed run. Its
`DiagnosticInvariantSnapshot` contains only a `HarnessInspection` and optional
content-free event summaries (`type`, ids, ordinal, attempt count). An invariant
may fail the caller's test by returning a `HarnessDiagnosticFinding`; the helper
throws `DiagnosticInvariantError` with id and sanitized path. It may not mutate
state, retry providers, execute tools, change policy, or emit model-visible
content.

The first supported invariant families are:

- configuration uniqueness and capability closure;
- tool call/result pairing and event-order monotonicity;
- bounded loop and retry counts; and
- redaction checks for diagnostic metadata.

The helper is synchronous, runs in registration order, and reports the invariant
id and sanitized finding path. It is never implicitly enabled by `NODE_ENV`.

## Acceptance and non-goals

Tests must prove recording cannot start without a sanitizer, sanitized fixtures
replay without provider I/O, strict ordering/mismatch/exhaustion/unused
interactions fail deterministically, cancellation remains observable, and no
raw content reaches fixtures or diagnostic errors. Tests must also prove
invariants are disabled by default, cannot mutate run state, and identify a
pairing/order/retry violation with content-free metadata.

This scope excludes golden production traffic capture, remote fixture stores,
automatic redaction claims, differential model evaluation, a generic plugin
system, model-output grading, and always-on runtime assertions. Those require a
separate product and privacy design.
