# Administration, retention, and offboarding

## Inventory — DEC-SOWN-ADMIN

Every resource is indexed by exact `SandboxOwner` before its external creation.
The adapter-private journal records resource kind, lifecycle state, opaque
provider reference, ownership, timestamps, size when known, and recovery pins.
Provider references never cross the public boundary. Local implementations may
use their existing private files/maps/SQLite coordinator; a new public storage
port is forbidden. In-memory adapters provide the same semantics within their
documented process authority and fail attach after loss of that authority.

Owner state is `active -> revoking -> revoked`; resource state is
`provisioning -> active/paused/terminal -> cleanup_pending -> deleted`, with
`state_lost` when reconciliation cannot find known backing state. Invalid
transitions fail closed. A bounded provisioning intent persists before create;
timeouts do not erase it. Reconciliation can identify exactly owned leftovers
and delete/retry them without adopting an unrelated resource. Record/journal
updates use existing atomic transaction or same-filesystem replace discipline;
fs promises alone provide no concurrent mutation exclusion.

## Offboarding and purge

An application calls the sandbox adapter's `administration.purge` first, repeats
the same selector/key until completed, then does the same on its durable workspace
adapter. Do not delete a bound workspace while sandbox purge is pending. A
workspace adapter additionally rejects deletion while its private binding
coordinator still reports live writers. Both phases are required; neither is
advertised as whole-system account erasure. A retained indexed resource remains
discoverable even if its original session/run row was deleted.

Purge first persists a selector revocation barrier and an idempotency journal,
then invalidates matching live attachments, stops owned processes, and deletes
matching owned resources/snapshots. Registration, open, restore, snapshot resume,
new process admission, and queued filesystem work must consult that barrier.
Deletion may override pins only after revocation and confirmed writer stop.

| Selector | What is deleted | What access is revoked |
| --- | --- | --- |
| Exact owner | Its partitions, retained runs, workspaces, snapshots | Every attachment to that owner incarnation |
| Tenant + namespace | All owners with that exact tenant, including principal owners | All actors in that tenant/namespace |
| Principal + exact optional tenant + namespace | Only owners whose owning identity has that principal and exact tenant | That acting principal's attachments, including tenant-owned shared partitions |

Principal purge never deletes tenant-owned shared files. Revoked actors cannot
re-enter them with another session/owner incarnation. Other principals continue
to use shared partitions. Actors whose identity does not contain the selected
principal are not inferred from session IDs. Cross-namespace offboarding requires
an explicit call for each application-managed namespace; there is no global scan
or wildcard delete. Identities and owner indexes are sensitive administrative
data and are not ordinary telemetry.

Purge of an absent owner still installs the barrier so a racing create cannot
arrive after successful deletion. The same idempotency key plus different
selector fails `SandboxConflictError`; exact retries resume durable progress.
The revocation and job records reserve catalog capacity before creation is
admitted; destructive cleanup must remain possible when normal admission is
full. Quota counts reserve one revocation/job slot per admitted owner plus the
configured selector-barrier reserve; see bounded catalog below.

On cancellation before barrier commit, abort with no deletion. After barrier
commit, cancellation stops further work but never rolls back revocation; return
`cleanup_pending` with the committed progress. Provider outages and partial
deletions also return pending, preserving every still-needed private reference.
Use bounded adapter retry/backoff; `retryAfterMs` defaults to 1000 and may rise
to 60000. A successful provider not-found acknowledgement counts as deleted;
permission/transport/timeout failure does not. `completed` requires reconciliation
of all known provisioning intents and confirmed absence of owned backing data.

Operator offboarding does not wait for a model run to cooperate. The adapter must
stop or fence its sandbox effects; a now-running model call can finish but its
next sandbox operation is denied. The application separately disables incoming
user work. Reinstating a revoked tenant/principal and transferring ownership are
outside this release; do not silently remove barriers on re-registration.

## Bounds — DEC-SOWN-BOUNDS

Constructor options declare and validate supported policy fields. Supplied but
unsupported fields throw `HarnessConfigError`, including positive-looking fields
that an implementation cannot actually enforce. Omitted fields use the exact
adapter defaults below. Negative, zero, non-finite, fractional count/byte/time
limits, or inconsistent caps fail construction. No hard limit silently becomes
a best-effort measurement.

| Local adapter setting | Default | Enforcement |
| --- | --- | --- |
| `maxCatalogEntries` | 10000 | All owner/resource/pin/job/revocation entries, including deleted tombstones |
| `maxActiveSandboxes` | 64 | Across the adapter authority, atomic admission |
| `selectorRevocationReserve` | 256 | Catalog slots unavailable to normal allocation, for tenant/principal offboarding |
| Workspace `maxActiveWorkspaces` | 32 | Across the workspace adapter authority |
| Workspace `maxPausedWorkspaces` | 32 | Pause admission; current committed checkpoint remains safe on denial |
| Workspace `maxConcurrentResumes` | 4 | Fail quota rather than unbounded queueing |
| Workspace `maxSnapshotsPerWorkspace` | 32 | Includes committed, uncommitted, pinned, and failed-cleanup snapshots |
| Workspace `maxRetainedSnapshotBytes` | 1073741824 | Aggregate per workspace, includes temporary/incomplete copies |
| Workspace `maxSnapshotBytes` | 268435456 | Individual checkpoint copy, enforced while copying |
| Workspace `maxCheckpointPayloadBytes` | 1048576 | Serialized replay payload before copy/publication |
| Retention `cleanupMode` | `application_scheduled` | Application must call `administration.sweep`; no hidden core timer |
| `terminalSuccessTtlMs`, `terminalFailureTtlMs`, `abortedTtlMs` | 604800000 | Seven days after persisted terminal/aborted transition, only unpinned data |
| `orphanTtlMs` | 86400000 | One day after confirmed orphaning, not merely a missed heartbeat |

`maxCatalogEntries`, `maxActiveSandboxes`, and `selectorRevocationReserve` live in
the sandbox adapter factory's `administration` options; workspace catalog limits
live in its factory's `administration` options. These are local-adapter defaults,
not Harness runtime defaults. Remote adapters must publish finite supported
defaults and pass the same contract before selection. Default standalone in-
memory/bash/local adapters participate too; an in-memory catalog is bounded but
not durable across process loss.

The catalog validates at most 256-byte identifier fields and bounded journal
records, never content/output. Each admitted owner reserves capacity for its own
terminal barrier and purge progress; those reservations count toward the cap.
Additional selector barriers use the reserve. If that reserve is exhausted,
revoke/deletion fails **before claiming success** and the operator must deny
incoming work externally and provision a larger bounded catalog; no record is
discarded. Raising a cap is explicit operator configuration, not automatic growth.

Do not expire revocation/tombstone entries merely by age: an arbitrarily late
stale caller must not recreate a scope. Keep compact terminal records under the
catalog cap; reject new admission when full. Safe compaction via namespace
retirement is a future feature, not an implementer-invented TTL. Delete bulk
resource payloads while retaining the minimal barrier. No eternal file payloads
are justified by retaining a small terminal record.

`activeTtlMs`, `pausedTtlMs`, `maxTtlMs`, and `maxWorkspaceAgeMs` have no default.
They are not accepted by the first local adapters because expiring a live or
recovery-pinned workspace without an application run-cancellation policy would
destroy the recovery guarantee. `manual_only` is accepted only without TTL fields;
`adapter_automatic` is rejected by these adapters until a real scheduler is
provided. Unknown defaults must not be invented by an implementer.

Existing `maxWorkspaceBytes`, `maxWorkspaceFiles`, and `maxSingleFileBytes` are
rejected for unrestricted local exec/Docker filesystems: a post-copy or pre-open
measurement is not a hard live-filesystem quota. Local checkpoint byte/payload
limits above are supported and measured with bounded streaming copy, no symlink
traversal outside the owner tree, and cleanup of failed temporary copies. An
adapter offering only mediated filesystem writes may accept hard limits only
with atomic reservations for every write and the same conformance tests.
This first slice rejects those three fields uniformly across built-in factories
to keep the supported public policy predictable.

Docker CPU, RAM, PID and temporary-storage defaults from spec 34 remain unchanged.
Persistent volume capacity is an operator/engine/filesystem concern; document
that Docker Desktop/OrbStack does not provide this port a portable hard volume
byte limit. Configured portable hard byte quotas fail construction. The catalog
and active-container count are bounded, but do not claim that alone bounds
arbitrary bytes a command may write. Production use requiring a hard disk cap
must supply an enforceable engine/host quota or select another adapter.

## Snapshot garbage collection

Snapshot inventory covers optional provider snapshots and local durable
checkpoints, not just running compute. All snapshots carry their owner, age,
size when known, and pin state. A snapshot implementation must configure finite
count/byte caps; unknown size cannot be admitted under a hard byte cap without
an enforceable provider upper bound. Local checkpoint defaults are above; the
snapshot test adapter uses the same count/byte limits. No production snapshot
capability is added to Docker by this work.

Before a checkpoint, bounded maintenance may delete the oldest eligible,
unpinned snapshots. Keep the latest committed recovery point and all explicitly
pinned points. If limits still prevent admission, fail before publication and
leave the prior committed state intact. A temp copy counts against reserved
bytes; failure to remove it remains cleanup-pending and consumes capacity.

`sweep` processes at most its requested number of records and returns a
continuation. An active/suspended run is never inferred terminal from elapsed
time. Uncommitted snapshots are eligible only when reconciliation confirms no
pending commit can publish them. A local process restart does not prove orphaning.
Count caps provide bounded admission even if an operator forgets to schedule
sweeps; TTL is cleanup eligibility, not a claim that deletion happened on time.

## Operator runbook contract

Document setup of a periodic caller-controlled sweep for each configured adapter,
bounded pagination, retry of pending purges, denial/capacity alarms, principal
versus tenant offboarding, recovery-pin investigation, and the Docker disk-cap
limitation. Explicitly separate sandbox cleanup from history/memory/result receipt
retention. Administrative list output may contain sensitive owner identity; no
raw output belongs in normal logs. No CLI, endpoint, scheduled service, or global
account-delete orchestration is added by this plan.
