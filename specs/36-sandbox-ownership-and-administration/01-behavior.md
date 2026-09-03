# Selection and lifecycle semantics

## Current implementation evidence

Evidence is the dirty workspace at baseline `c378607de9e7`, inspected 2026-08-26;
the baseline includes the preceding sandbox work, not just committed HEAD.

| Invocation today | Filesystem ownership today |
| --- | --- |
| Ordinary top-level agents/workflows in one Harness session | Shared session sandbox |
| Inline `ctx.agents.*` delegate | Exact parent sandbox |
| Durable workflow with workspace binding | Run sandbox shared by delegates |
| Durable workflow without workspace binding | Session sandbox |
| `childTasks` | Isolated task-run sandbox |
| Separate PURISTA attached agents | Separate Harness names and namespaced sessions |
| PURISTA wrapped workflow's inline agents | Parent workflow sandbox |
| PURISTA `canInvokeAgent` | Separate attached-agent boundary |

Sources: `packages/harness/src/sessions/index.ts`,
`runtime/sessionDurable.ts`, `sandbox/lifecycle.ts`, and
`../purista/packages/core/src/AgentQueueBuilder/runtime/{executor,identity,scopedRuntime}.ts`.
Current definition types do not have a sandbox-sharing policy. Current optional
identity already participates in the sandbox scope key but is not an inventory
index. Current local TTL fields are not enforced, Docker volumes have no portable
hard disk quota, and session close does not enumerate retained run workspaces.

## Selection — DEC-SOWN-SELECTION

Policy precedence, from highest to lowest:

1. `childTasks.start(..., { sandbox: policy })` for that child invocation only.
2. The target agent/workflow definition's `sandbox` property.
3. For a background child task, the built-in isolated task-root behavior; for an
   inline delegate, inherit the caller's resolved partition.
4. For top-level ordinary/durable invocations only, the Harness binding's
   `defaultPolicy`, default `inherit`.

An inline delegated agent uses its own definition policy when present; otherwise
it inherits the caller's **resolved partition**, not the session's primary
partition. Top-level `inherit` resolves the owner lifetime's shared partition.
`private` resolves the target definition's partition; agent/workflow kinds remain
distinct even with the same ID. Private keys also include the Harness name so
equally named definitions in different Harnesses do not collide under a shared
explicit owner. `{ group }` resolves the configured group within
the same owner and lifetime. Definition IDs are the fully registered IDs after
static-module namespacing. No runtime string callback chooses a partition.

| Call | Inherit | Private | Group |
| --- | --- | --- | --- |
| Top-level ordinary invocation | Owner/session shared | Definition partition, reused across turns | Named owner/session partition |
| Inline delegate | Caller partition | Target definition within current lifetime | Named partition in current lifetime |
| Durable invocation | Run shared | Definition within run | Named partition within run |
| Background task, explicit policy | Parent partition | Target definition within parent lifetime | Group within parent lifetime |
| Background task, no explicit/definition policy | New task-run shared partition | N/A | N/A |

Background tasks remain isolated by default even if `defaultPolicy` is `private`
or a group. Configuring a definition explicitly for a group changes both direct
and child calls to that definition. Shared child tasks are intentional borrowers;
they never terminate the parent's partition. Multiple concurrent writers are
allowed outside durable checkpoint boundaries; sharing is not serialization,
transactionality, or a substitute for application file locking.

No new per-invocation lifetime switch is introduced. Ordinary owners live until
explicit close/purge or configured expiry; durable partitions belong to the run;
default-isolated background partitions belong to the task run. A new ordinary
invocation-private environment uses a fresh ephemeral session. This avoids a
second, interacting policy vocabulary.

## Ownership — DEC-SOWN-OWNER

Implicit owner: namespace = Harness name, id = persisted session ID,
instanceId = immutable `SessionRecord.instanceId`, identity = exact session
`HarnessIdentity`. Do not invent absent tenant/principal values. Canonical keys
use a versioned, unambiguous tuple with explicit optional-field presence; strings
are UTF-8, case-sensitive, not normalized or delimiter-concatenated. Adapters hash
the tuple for private paths and labels and separately index its validated fields.

Explicit owner: application composition first registers an owner on the chosen
adapter; `getSession` receives that exact owner and treats it as borrowed.
The `authorizeOwner` callback is required for explicit owners, even when identity
matches. It receives trusted session identity, never model arguments. Tenant
presence and tenant value must match before the callback. A principal-owned
owner additionally requires exact principal equality. A tenant-owned owner omits
principal; access by an actor with a principal requires callback approval.
Unscoped explicit owners are allowed only for unscoped actors and explicit
approval. A callback cannot override these scope checks.

The callback runs before every top-level invocation and child launch and again
after suspension/resumption; initial `getSession` validation also invokes it.
Existing attachment revocation is enforced by the adapter at every filesystem,
exec, spawn, and snapshot mutation/read admission. A callback is application
authorization, not a replacement for the adapter's persisted offboarding barrier.

Owner binding is immutable for a SessionRecord incarnation. Its `policyDigest`
is the SHA-256 of the versioned owner-binding/layout tuple only, not the complete
definition graph. Reopening with a different owner is a conflict. Ordinary
definition policies may change: a new invocation resolves the selected partition
and never moves existing files. Adding an unrelated definition does not invalidate
an existing session. Moving files to another owner or changing a durable policy
requires an explicit future export/import operation; none is added here.

Sharing files is explicit data sharing. It does not share conversation messages,
memory namespaces, model state, approvals, or tool/skill allowlists. Skill files
mounted in a shared partition are visible to its other authorized members;
applications requiring file secrecy use private partitions. Skill mount and MCP
stdio caches are keyed by the resolved attachment/partition, not just session ID.

## Registration and lazy allocation — DEC-SOWN-LAZY

`getSession` persists the session and its immutable logical binding, then registers
the implicit owner, without allocating a filesystem or compute. The binding's
registration state is `pending` until adapter registration acknowledges success;
the session update is conditional on the same session incarnation. Only then may
an invocation open a partition. Two creators use the existing insert-only session
write and reread the winning incarnation before registration. Registration
retries are idempotent, including after a crash between acknowledgement and the
session update. No compute can exist from this flow while registration is pending.

A registered binding calls `registerOwner(mode: 'attach')` after restart. Missing
owner metadata is state loss. Borrowed owners use attach only and never register
as new. For a registered active owner, `open(mode: 'create')` means first-use
admission for that partition: allocate if its journal says never allocated,
otherwise attach to the recorded generation. Missing recorded compute/files,
termination, or an indeterminate create cannot be treated as never allocated.
Adapters persist provisioning intent before side effects and reconcile uncertain
results before allowing another create. `attach` remains a strict existing-
partition operation; `restore` retains spec-34 recovery authority.

This deliberately replaces spec 34's requirement that core remember each newly
allocated partition. The adapter, not HarnessStorage, owns partition allocation
history. Session storage holds only owner binding, ownership relation,
registration acknowledgement, and policy digest—not a lifecycle directory.

Terminal idempotent invocation results are checked before partition open. A
replayed completed result therefore works after compute was purged. Registration
attach is also deferred until a call actually requires live resources; loading a
session or reading a completed receipt does not demand a surviving owner.

## Durable runs — DEC-SOWN-DURABLE

All durable invocations use run lifetime, including adapters without workspace
binding. Those without binding retain their honest state-loss behavior; no
checkpoint guarantee is inferred. An explicit borrowed owner on a durable
invocation is rejected with `HarnessConfigError` before run admission, model
calls, workspace creation, or sandbox access. Cross-run sharing is unsupported.

For compatible `DurableWorkspace` plus `sandbox.workspace_binding`, keep one
existing `WorkspaceHandle` and one committed `workspaceRef/checkpointRef` per
step. Its active tree contains `partitions/<canonical-partition-hash>/workspace`.
The primary partition is a subdirectory too; no guest receives the aggregate
root. The workspace ownership marker and restoration epoch live outside active
and checkpoint trees. Bindings carry owner and run identity explicitly, not in
arbitrary metadata. The same host path must not be claimed by another owner/run.

The run's partition-policy digest covers the resolved registered definition IDs,
their policies, default policy, configured groups, and layout version. Persist
it in the durable workspace/checkpoint metadata and replay record. Resume with a
different digest fails `SandboxConflictError` before replacing files. The digest does
not include transient call order or newly discovered paths. Default-isolated
background tasks remain ephemeral: the existing child-task contract persists
completed result descriptors, not task-workspace checkpoints. They are not copied
into the parent's checkpoint. Restart of an unfinished isolated task follows the
existing recovery-required failure, not a newly invented task recovery engine.

Serialize checkpoint commits for a run. A commit requires all child work to be
joined and all exec/spawn writers in the run's partitions to be stopped. Otherwise
fail `SandboxConflictError` before copying; do not implicitly wait or deadlock. Once
quiescent, take one run-wide barrier that denies new operations, copy all
partitions with bounded admission, publish the checkpoint, then release the
barrier. Filesystem promises/copy alone are not a transaction or write barrier.

Restore first revokes/stops every attachment in that run, not only the partition
that noticed failure. Resume the last committed aggregate checkpoint; then
authorize replacement generations and lazy partition reattachment. Never expose
half-restored partitions. Each checkpoint also commits the exact membership list
of partitions captured in its tree. A partition first created after that checkpoint
is rolled back to its known not-yet-created state by this explicit restore; the
adapter may authorize a replacement generation when replay reaches it. This is
checkpoint-authorized rollback, not create-on-missing. A partition listed in the
checkpoint whose files are absent is corruption/state loss and cannot be emptied.
Failure leaves the run unavailable and retryable from
the same committed reference; it must not start from an empty active tree.

Uncommitted copied checkpoints are initially unpinned but protected by their
pending-publication journal. Runtime pins the candidate before storage publication
and releases the previous recovery pin only after publication succeeds; crash
reconciliation keeps both pins until storage proves which committed reference
is current. A failed publication must not delete the previous recovery point.
Nonterminal runs, suspended waits, and active replay claims retain their pins.

## Completion and cancellation

`release()` detaches resources owned by that session's attachments; it never
purges logical owners. `close()` purges implicit-owner sandbox resources and
associated durable workspaces, awaiting completed cleanup before deleting the
SessionRecord. Partial cleanup leaves the record available for retry. For a
borrowed owner it detaches and closes only that session's history/resources; it
must not delete the shared owner or another borrower's run/workspace.

Successful/failed/cancelled isolated child tasks terminate their owned partition;
shared children detach. Durable terminal cleanup follows configured retention
and releases recovery pins only after terminal result persistence. Suspended
or retryable runs are not terminal. Shutdown detaches only; it neither purges all
owners nor assumes a process-local list is a complete resource inventory.
