# Sandbox ownership, sharing, and administration

Status: approved specification; implementation requires a separate execution request.
Date: 2026-08-26. Authority: repository owner's standing specification approval.

## Outcome

One `Sandbox` interface serves standalone Harness and PURISTA. Applications
configure **which files are shared**, not whether an adapter is distributed.
An adapter owns coordination, generations, fencing, provider references, resource
inventory, quotas, and deletion. Harness owns definition selection and execution;
PURISTA maps its public configuration and trusted message context to Harness.
Neither package imports the other's private implementation.

The three sharing policies are `inherit`, `private`, and `{ group: name }`.
Sharing never merges conversation history, tool permissions, identity, or run
records. Private means private to a registered agent/workflow definition within
one owner and lifetime, not a new directory for every invocation.

Owners have exact optional tenant/principal identity, an explicit namespace, and
an opaque incarnation. Resource IDs are opaque; raw identity is not concatenated
into paths, container labels, telemetry, or user-visible sandbox IDs. An owner
index, not ID-prefix matching, supports precise offboarding.

## Approved boundaries — DEC-SOWN-BOUNDARY

This feature extends spec 34 only for ownership, definition sharing, lazy
partition allocation, administration, and bounded retention. Spec 34 continues
to govern topology transparency, adapter-private fencing, durable-file recovery,
state loss, Docker packaging/security, and the production-provider bake-off.
The exact replacement map is [delivery](./04-delivery.md#precedence).

There is no `MultiInstanceSandbox`, sandbox router, separate lifecycle service,
new control-plane package, core cleanup daemon, grant database, or generic
resource-management framework. One adapter instance is configured per Harness;
all partitions use it. Operator administration is an adapter property, never an
agent tool. Local Docker stays the existing independent addon, including OrbStack
through the Docker API/CLI. No E2B or Daytona adapter is implemented in this plan.

Durable files in the last committed workspace checkpoint are the recovery
guarantee. Process preservation stays optional. Missing known resources fail;
they are not silently replaced with empty directories or containers.

## Requirements

### REQ-SOWN-POLICY

Resolve inherited/private/group policies deterministically for top-level agents,
workflows, inline delegates, and background tasks. Preserve existing ordinary
sharing and default background-task isolation. Literal group names, adapter
capabilities, and module composition remain statically inferred and validated at
build time. See [selection](./01-behavior.md#selection).

### REQ-SOWN-OWNER

Separate ownership from acting identity and history. Bind implicit owners to the
persisted session incarnation; authorize explicit borrowers before execution;
persist first-use registration before opening compute. A released, never-used
session can initialize after restart; initialized missing state cannot.

### REQ-SOWN-DURABLE

Checkpoint all run-owned partitions in one existing durable workspace. Restore
them as one fenced unit, verify the partition-policy digest, and reject external
shared owners and unresolved concurrent writers before durable side effects.

### REQ-SOWN-ADMIN

Expose typed, bounded adapter administration for indexed inventory, purge, and
retention sweeps. Owner/tenant/principal selectors are exact and namespace-bound.
Revocation precedes deletion; partial deletion is durable and retryable. Principal
offboarding preserves tenant-owned shared files while revoking that principal's
attachments. Run resources and all owned snapshots remain discoverable after a
session record has gone.

### REQ-SOWN-BOUNDS

Enforce every accepted retention/quota field or reject it at construction.
Bound catalogs, unpinned snapshots, checkpoint copies, and lifecycle admission.
Never prune a checkpoint required for a nonterminal run or discard revocation
tombstones to make capacity. Report unsupported live-filesystem byte limits
truthfully, especially for Docker volumes.

### REQ-SOWN-PURISTA

Map framework identity, sharing, and owner selection through public Harness
types. Keep attached-agent conversations separate. Make ephemeral completion
purge owned compute without destroying retry results; suspension preserves files.
Remove misleading `sandbox.enabled: false` and all legacy sandbox shapes.

### REQ-SOWN-SAFETY

Use closed schema-derived boundary types, existing error families, content-free
telemetry, cancellation-safe operations, and no arbitrary object casts. Denial,
quota, state-loss, stale attachment, and partial cleanup are explicit outcomes.

### REQ-SOWN-DELIVERY

Rewrite all existing implementations, fakes, consumers, docs, and examples in one
clean release. Standalone packed Harness and Docker consumers and a separately
built PURISTA integration must pass. Autonomous tickets may choose only private,
reversible details allowed by the conventions; missing semantics are blockers.

## Non-goals

Cross-run shared mutable workspaces inside durable execution; filesystem views
that hide files from another authorized member of the same partition; automatic
checkpoint migration across changed partition policies; global data erasure of
conversation/memory/evaluation storage; live-process recovery guarantees; new
dependencies or dependency upgrades; production provider selection. A sandbox
purge must not be advertised as complete account-data erasure.

## Reading order

Read this file, [behavior](./01-behavior.md), [contracts](./03-contracts/api.md),
[administration](./02-administration.md), [PURISTA mapping](./05-purista.md),
[verification](./04-verification.md), [delivery](./04-delivery.md), and the
machine-readable controls. The new nested implementation plan is the only
executable plan for this follow-up; previous accepted sandbox work stays historical.
This feature is the single source of truth for its changed contracts; older
specification text is read with the explicit precedence map, not duplicated here.
