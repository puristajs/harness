# End-to-end flows

## FLOW-SBX-01 — first and concurrent open

Core determines that the session/run scope is newly allocated, validates the
bound identity, constructs the logical scope, and calls
`sandbox.open({ mode: 'create', scope })`. The adapter atomically creates
generation `1` or attaches to the generation created by a concurrent client.
Two independently constructed clients may obtain attachments, but the
adapter's internal lease/fence rules ensure only the current attachment can
mutate compute.

## FLOW-SBX-02 — release and replica handoff

`Session.release()` calls the opened `SandboxSession.close()`. It detaches the
client without terminating logical compute or deleting Harness persistence.
Another replica opens the persisted scope with `mode: 'attach'` and attaches to
the same generation. Attachment-local process objects and streams are invalid
after detach even if provider processes continue running.

## FLOW-SBX-03 — stale attachment

After ownership changes, every filesystem, exec, spawn, snapshot, resume,
hibernate, and termination mutation attempted through the stale attachment is
rejected by the adapter at the compute boundary. No public fencing token is
required. This guarantee is limited to sandbox mutations; broader distributed
session/run serialization remains owned by existing Harness storage/run rules.

## FLOW-SBX-04 — provider loss with durable files

For a resumed durable run, Harness resumes the latest committed
`DurableWorkspace` checkpoint and establishes the spec-21 sandbox binding
before sandbox open. It then passes `mode: 'restore'`. If the adapter finds the prior
generation `lost`, it creates exactly the next generation and returns
`disposition: 'restored'`. Files come from the durable workspace. The reported
live-process outcome may be `restarted`, `not_preserved`, or `unknown` without
weakening file recovery.

## FLOW-SBX-05 — provider loss without durable recovery

An existing ordinary session, a non-durable run, or a durable run without a
successfully resumed committed workspace uses `mode: 'attach'`. Missing
lifecycle state or authoritative provider absence throws
`SandboxStateLostError`; no replacement is created. Repeating
the request observes state loss until the application explicitly closes and
creates a new logical session/run or supplies valid durable recovery.

## FLOW-SBX-06 — identity mismatch

The existing session identity binding rejects a request whose optional
tenant/principal fields differ in value or presence. This happens before
sandbox open. Standalone Harness may intentionally use no identity;
PURISTA may reject missing tenant/principal earlier when its application policy
requires them.

## FLOW-SBX-07 — termination and cleanup

`Session.destroy()` detaches and calls `Sandbox.terminate(...)` to durably accept
termination before deleting the `SessionRecord`; a transient failure leaves the record for
retry. Terminal run disposal requests termination for its run scope without
changing the already-decided business result. The adapter owns provider
deletion retries, retention, and orphan reclamation. Provider not-found during
explicit termination is idempotent success. A later new `SessionRecord` may
reuse the caller-facing session id safely because its new opaque `instanceId`
produces a different logical scope; the terminated scope may be compacted to a
content-free tombstone. Storage deletion compares the expected instance id
atomically so another client's stale close cannot remove the new record.

## FLOW-SBX-08 — outage and cancellation

Cancellation stops the current adapter request without fabricating lifecycle
state. Provider outage, timeout, quota, or unauthorized responses remain their
typed/transient outcomes and never become `lost`. Only authoritative provider
absence may create the adapter-private lost tombstone.

## FLOW-SBX-09 — PURISTA integration

PURISTA maps its authenticated message/runtime identity into the existing
`HarnessIdentity`, applies application startup requirements, and invokes the
public Harness session/run API. PURISTA does not derive generations, manage
leases, see provider references, or duplicate lifecycle telemetry.

## FLOW-SBX-10 — local Docker and OrbStack

A developer explicitly configures `dockerSandbox(options)` and supplies a
local engine and pre-provisioned image. After configuration/engine preflight,
the same Harness scope and lifecycle calls create the owned container/volume,
execute inside it, release, and reattach after a Harness restart. Local
ownership checks reject competing or stale writes. Explicit close removes
only the recorded owned resources, retaining a terminal tombstone; interrupted
cleanup remains retryable. No PURISTA dependency or cloud credential is needed.
See `05-integration/local-docker.md` for security and release evidence.

## FLOW-SBX-11 — local Docker missing state or unavailable engine

An unavailable engine returns an operational error without changing generation.
Missing container, volume, or metadata returns state loss and never creates a
replacement. The initial Docker package has no compatible workspace binding;
restore requests fail `durable_workspace_recovery_unavailable` without mutation.
Recovery is explicit operator remediation or a new logical scope, never an
automatic empty reset. No path, context, provider reference, command, or output
is copied to diagnostics.
