# Sandbox ownership implementation plan

Status: approved source, TICKET-001 contract foundation accepted after independent remediation review.
Source digest: sha256:9578b59d21602ef020997d76a876d99df6e98728ea41834c8fd981c0d38e0acb. Working directory for every command and
scope below: `/Users/sebastianwessel/projekte/@purista`, not the Harness subfolder.

## Outcome

One topology-transparent Sandbox port, three sharing choices, exact optional
owner identity, bounded adapter administration and replay-safe PURISTA integration.
Harness and Docker remain standalone. No production provider is selected or built.
Canonical source: [spec 36](../../specs/36-sandbox-ownership-and-administration/00-vision.md).

## Execution rules

This document is approved planning only; execution needs the owner's separate
request. Current dirty-worktree changes are implementation evidence, not an
accepted delivery and must not be extended by this plan.
Every ticket pins the approved spec and plan content digests. The controller
promotes a planned ticket only after all depends_on/blocked_by tickets are accepted,
updates all four indexes and ticket lifecycle together, regenerates the plan
manifest, and reruns the checker before handoff. Implementation agents return
implemented evidence; independent review owns accepted. Do not reuse a stale
plan digest after status or source changes.

D0/D1 private reversible work only. Public types, names, defaults, errors,
ownership, quotas and recovery are fixed. A contract/prerequisite/authority gap is
a blocker, not an implementer choice. Preserve existing evaluation and handbook
changes. No automatic data migration or empty state replacement.

## Waves and dependencies

| Wave | Tickets | Outcome |
| --- | --- | --- |
| 1 | [TICKET-001](wave_01_contracts/tickets/TICKET-001-contracts.md) | Closed ownership and administration contract foundation |
| 2 | [TICKET-002](wave_02_private_catalogs/tickets/TICKET-002-local_catalog.md) | Private local owner catalog and administration primitives |
| 2 | [TICKET-003](wave_02_private_catalogs/tickets/TICKET-003-docker_catalog.md) | Docker-private indexed ownership and purge preparation |
| 2 | [TICKET-014](wave_02_private_catalogs/tickets/TICKET-014-docker_durable_catalog.md) | Durable Docker owner/catalog journal correction |
| 2 | [TICKET-013](wave_02_private_catalogs/tickets/TICKET-013-packed_verification.md) | Offline packed Harness and PURISTA verification prerequisite |
| 3 | [TICKET-004](wave_03_port_cutover/tickets/TICKET-004-port_cutover.md) | Atomic Sandbox port and lazy implicit-owner cutover |
| 4 | [TICKET-005](wave_04_sharing/tickets/TICKET-005-sharing.md) | Typed sharing policies for agents workflows and child tasks |
| 5 | [TICKET-006](wave_05_durable_partitions/tickets/TICKET-006-durable_partitions.md) | Aggregate durable partitions checkpoint pins and terminal lifecycle |
| 6 | [TICKET-007](wave_06_retention/tickets/TICKET-007-retention.md) | Enforced workspace snapshot retention and bounded sweeps |
| 7 | [TICKET-008](wave_07_replay/tickets/TICKET-008-replay.md) | Replay-safe terminal disposal for agent and workflow invocations |
| 8 | [TICKET-009](wave_08_purista/tickets/TICKET-009-purista.md) | PURISTA public policy mapping identity and ephemeral completion |
| 9 | [TICKET-010](wave_09_conformance/tickets/TICKET-010-conformance.md) | Cross-adapter administration privacy and package conformance |
| 10 | [TICKET-011](wave_10_docs/tickets/TICKET-011-docs.md) | Standalone and PURISTA examples guidance and canonical skills |
| 11 | [TICKET-012](wave_11_release_review/tickets/TICKET-012-release_review.md) | Independent clean-release review and local-engine evidence gate |

Wave 2 begins with the disjoint local/Docker-private catalog and packed-verification
work. TICKET-014 is a serial Docker correction after TICKET-003: registration
survives restart today, but inventory, revocation, and purge progress do not.
Wave 3 is an approved atomic public-boundary cutover only; owner disposal and
workspace lifecycle stay in their already-planned later vertical slices. Sharing,
durability, retention, replay, Framework mapping, conformance, docs and release
review are serial vertical slices. No intermediate package is published.

## Verification and external gates

Default command metadata forbids network, secrets and writes outside the workspace.
Real Docker engine tests are separately authorized operator verification in
TICKET-012; an already-present digest-pinned image is required. Missing engine
proof blocks release, not source planning. Prior spec-34 results are historical.
No provider/cloud mutation, image pull, project dependency install or publication
is implicit. TICKET-013 explicitly permits isolated offline test installs with
workspace-local scratch/cache and cached-input prerequisites; it never replaces
the developer's node_modules or lockfiles.

The existing packed-Core strict declaration failures are explicit final-release
prerequisites in VERIFY-SOWN-PACKAGED-PURISTA. Source-mode checks use the actual
new local Harness package and can prove implementation behavior; final consumer
mode must pass after separately approved dependency/package remediation. No
ticket may waive that failure or invent a dependency/type-shim workaround.

Every canonical requirement/capability/path/acceptance ID is covered by tickets;
TICKET-012 independently checks the integrated result. Public package/type,
regression, coverage and knowledge/skill gates must remain green without lowered
thresholds or compatibility shims. The prior dated sandbox plan stays historical.

## Self-Audit

All eight requirement/capability/path/acceptance chains are assigned to concrete
tickets. Closed contracts and durable private catalog foundations precede
adapter/runtime cutover; one disjoint parallel group is permitted, all other
changes are serial.
The atomic cutover has explicit phase gates and a clean-release boundary.
Recovery, offboarding, quotas, standalone package checks, framework errors/types,
docs/skills and external local-engine evidence each have a named owner. No ticket
delegates a public semantic choice. Missing prerequisites or live evidence block
promotion/acceptance; planning checks are not runtime implementation proof.

## Controller verification commands

```sh
node /Users/sebastianwessel/.agents/skills/spec-readiness-review/scripts/check_specs.mjs ai-harness/specs/36-sandbox-ownership-and-administration
node /Users/sebastianwessel/.agents/skills/spec-implementation-planner/references/generate_plan_manifest.mjs . ai-harness/plans/sandbox-ownership ai-harness/specs/36-sandbox-ownership-and-administration
node /Users/sebastianwessel/.agents/skills/spec-implementation-planner/references/check_plan.mjs . ai-harness/plans/sandbox-ownership ai-harness/specs/36-sandbox-ownership-and-administration
```

The spec and plan reports distinguish structural readiness from future runtime
proof. Do not mark a ticket accepted merely because these planning checks pass.
