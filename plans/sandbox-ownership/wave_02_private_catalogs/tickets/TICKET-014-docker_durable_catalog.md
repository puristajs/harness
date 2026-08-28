---
id: TICKET-014
title: Durable Docker-private owner catalog correction
wave: 2
lifecycle: planned
spec_manifest_digest: sha256:d428914333a9eab9a1f84659f3c4724028c5c4ca96c20be3c13c9edc4c4365cc
plan_manifest_digest: sha256:57fa5bbc511a90aa7bcc53096fc56a50e9db8025787adb8cda8175e9a7050039
parallel_group: serial-TICKET-014
depends_on: [TICKET-003]
blocked_by: [TICKET-003]
spec_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-OWNER, ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-ADMIN, ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-BOUNDS, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OWNER, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-ADMIN, ai-harness/specs/36-sandbox-ownership-and-administration/04-delivery.md#DEC-SOWN-DELIVERY]
write_scope: [ai-harness/packages/harness-sandbox-docker/src/records.ts, ai-harness/packages/harness-sandbox-docker/src/ownership.ts, ai-harness/packages/harness-sandbox-docker/src/administration.ts, ai-harness/packages/harness-sandbox-docker/src/lifecycle.ts, ai-harness/packages/harness-sandbox-docker/src/options.ts, ai-harness/packages/harness-sandbox-docker/src/ownership.test.ts, ai-harness/packages/harness-sandbox-docker/src/administration.test.ts, ai-harness/packages/harness-sandbox-docker/src/docker.test.ts]
read_scope: [ai-harness/specs/36-sandbox-ownership-and-administration, AGENTS.md, ai-harness/AGENTS.md, ai-harness/.agent/IMPLEMENTATION.md, ai-harness/package.json, ai-harness/packages/harness/src/sandbox, ai-harness/packages/harness/src/testing, ai-harness/packages/harness-sandbox-docker, purista/AGENTS.md, purista/skills/purista, ai-harness/skills/ai-harness, ai-harness/plans/sandbox-ownership]
contract_readiness:
  status: ready
  required_contracts: [CTR-SOWN-OWNER, CTR-SOWN-ADMIN]
  missing_contracts: []
traceability:
  requirement_ids: [REQ-SOWN-OWNER, REQ-SOWN-ADMIN, REQ-SOWN-BOUNDS]
  capability_ids: [CAP-SOWN-OWNER, CAP-SOWN-ADMIN, CAP-SOWN-BOUNDS]
  path_ids: [PATH-SOWN-OWNER, PATH-SOWN-ADMIN, PATH-SOWN-BOUNDS]
  acceptance_ids: [ACC-SOWN-OWNER, ACC-SOWN-ADMIN, ACC-SOWN-BOUNDS]
generated_contracts:
  status: ready
  source_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OWNER, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-ADMIN]
  command_refs: []
  drift_command_refs: [CMD-DOCKER_TEST, CMD-DOCKER_TYPES]
ticket_readiness:
  status: implementation_ready
  open_decisions: []
  ambiguous_phrases: []
slice_type: foundation_exception
phase_gate_exception: false
representation_reuse:
  status: ready
  catalog_ref: ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/representation-catalog.yaml
  shape_refs: [sown.owner, sown.scope, sown.administration]
  mapping_refs: []
  new_shape_decision: none
autonomy:
  allowed_classes: [D0, D1]
  convention_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-conventions.md#CONV-SOWN-PURISTA, ai-harness/specs/36-sandbox-ownership-and-administration/00-conventions.md#CONV-SOWN-TYPES, ai-harness/specs/36-sandbox-ownership-and-administration/00-conventions.md#CONV-SOWN-AUTONOMY]
  approved_decision_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#DEC-SOWN-BOUNDARY, ai-harness/specs/36-sandbox-ownership-and-administration/04-delivery.md#DEC-SOWN-DELIVERY]
  escalation: blocker
verification_commands:
  CMD-BASELINE:
    command: git -C ai-harness status --short
    purpose: Record the dirty baseline without changing it
    expected: record_only
    network: forbidden
    writes: read_only
    secrets: forbidden
  CMD-DOCKER_TEST:
    command: npm --prefix ai-harness run test --workspace @purista/harness-sandbox-docker
    purpose: Verify hermetic Docker ownership and administration behavior
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-DOCKER_TYPES:
    command: npm --prefix ai-harness run typecheck --workspace @purista/harness-sandbox-docker
    purpose: Compile the independent Docker package through public Harness imports
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-PACKAGE:
    command: npm --prefix ai-harness run verify:sandbox-packages
    purpose: Verify isolated package consumption without PURISTA or Harness-private imports
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
action_steps:
  - id: STEP-PREFLIGHT
    kind: preflight
    files: [ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md, ai-harness/packages/harness-sandbox-docker/src/records.ts, ai-harness/packages/harness-sandbox-docker/src/ownership.ts]
    command_refs: [CMD-BASELINE]
    acceptance_refs: [AC-TICKET-014-RESTART, AC-TICKET-014-PURGE, AC-TICKET-014-BOUNDARY]
    expected_proof: Record that the current owner registration file survives restart while resource/revocation/purge maps do not, then confirm no untracked provider resources are adopted.
  - id: STEP-CONTRACT
    kind: contract
    files: [ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md, ai-harness/specs/36-sandbox-ownership-and-administration/04-delivery.md]
    command_refs: [CMD-DOCKER_TYPES]
    acceptance_refs: [AC-TICKET-014-RESTART, AC-TICKET-014-PURGE, AC-TICKET-014-BOUNDARY]
    expected_proof: Reuse the public owner, selector, resource-summary, purge-result and error contracts exactly; the journal, provider references, locks and file paths stay Docker-private.
  - id: STEP-TEST
    kind: test
    files: [ai-harness/packages/harness-sandbox-docker/src/ownership.test.ts, ai-harness/packages/harness-sandbox-docker/src/administration.test.ts, ai-harness/packages/harness-sandbox-docker/src/docker.test.ts]
    command_refs: [CMD-DOCKER_TEST]
    acceptance_refs: [AC-TICKET-014-RESTART, AC-TICKET-014-PURGE, AC-TICKET-014-BOUNDARY]
    expected_proof: Add failing restart fixtures for inventory, revocation and partial purge continuation before changing the journal; prove malformed private metadata fails closed without creating a replacement sandbox.
  - id: STEP-IMPLEMENT
    kind: implement
    files: [ai-harness/packages/harness-sandbox-docker/src/records.ts, ai-harness/packages/harness-sandbox-docker/src/ownership.ts, ai-harness/packages/harness-sandbox-docker/src/administration.ts, ai-harness/packages/harness-sandbox-docker/src/lifecycle.ts, ai-harness/packages/harness-sandbox-docker/src/options.ts]
    command_refs: [CMD-DOCKER_TEST, CMD-DOCKER_TYPES]
    acceptance_refs: [AC-TICKET-014-RESTART, AC-TICKET-014-PURGE, AC-TICKET-014-BOUNDARY]
    expected_proof: Persist one versioned bounded Docker-private journal under the existing root using the existing atomic file conventions and cross-instance serialization. Persist exact owner metadata, opaque provider references, resource state, selector barriers and idempotent purge progress before side effects; reject an old or malformed layout before mutation.
  - id: STEP-VERIFY
    kind: verify
    files: [ai-harness/packages/harness-sandbox-docker/src/ownership.test.ts, ai-harness/packages/harness-sandbox-docker/src/administration.test.ts, ai-harness/packages/harness-sandbox-docker/src/docker.test.ts]
    command_refs: [CMD-DOCKER_TEST, CMD-DOCKER_TYPES, CMD-PACKAGE]
    acceptance_refs: [AC-TICKET-014-RESTART, AC-TICKET-014-PURGE, AC-TICKET-014-BOUNDARY]
    expected_proof: A new adapter instance with the same root sees only tracked inventory, cannot reopen a revoked owner, and resumes the same bounded purge without duplicate deletion or public provider-reference leakage.
  - id: STEP-HANDOFF
    kind: handoff
    files: []
    command_refs: [CMD-BASELINE]
    acceptance_refs: [AC-TICKET-014-RESTART, AC-TICKET-014-PURGE, AC-TICKET-014-BOUNDARY]
    expected_proof: Return exact changed paths, red/green tests, package proof and any local-engine limitation; do not mark the ticket accepted.
acceptance:
  - id: AC-TICKET-014-RESTART
    traceability_acceptance_ids: [ACC-SOWN-OWNER]
    requirement_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-OWNER]
    test_refs: [ai-harness/packages/harness-sandbox-docker/src/ownership.test.ts, ai-harness/packages/harness-sandbox-docker/src/docker.test.ts]
    command_refs: [CMD-DOCKER_TEST, CMD-DOCKER_TYPES]
    expected_outcome: Owner registration, tracked resource state and revocation authority survive a new DockerSandbox instance using the same root; missing or malformed private metadata fails closed.
    lifecycle: planned
  - id: AC-TICKET-014-PURGE
    traceability_acceptance_ids: [ACC-SOWN-ADMIN]
    requirement_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-ADMIN]
    test_refs: [ai-harness/packages/harness-sandbox-docker/src/administration.test.ts]
    command_refs: [CMD-DOCKER_TEST]
    expected_outcome: A cancellation or provider failure leaves durable cleanup_pending progress; retrying the same selector/key after restart completes only confirmed remaining tracked resources.
    lifecycle: planned
  - id: AC-TICKET-014-BOUNDARY
    traceability_acceptance_ids: [ACC-SOWN-BOUNDS]
    requirement_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-BOUNDS]
    test_refs: [ai-harness/packages/harness-sandbox-docker/src/ownership.test.ts, ai-harness/packages/harness-sandbox-docker/src/administration.test.ts]
    command_refs: [CMD-DOCKER_TEST, CMD-PACKAGE]
    expected_outcome: The correction remains an independent Docker package with bounded private state, public opaque summaries, no provider discovery fallback, no Harness-private import and no new public lifecycle service.
    lifecycle: planned
---

# TICKET-014 — Durable Docker-private owner catalog correction

## Goal

Make the existing Docker adapter's owner inventory, revocation barriers, and
purge progress survive adapter restart without changing the public `Sandbox`
contract or adding a coordination service.

## Context Digest

The source review found a narrow contract gap: `Records.registerOwner` persists
registration, while `DockerOwnershipJournal` stores resources, revocations and
purges only in process memory. A new adapter instance therefore cannot list a
previously tracked resource, retain a revoke barrier, or continue a partial
purge. This contradicts CTR-SOWN-ADMIN's durable journal requirement. The
existing `root` is the approved private metadata boundary and `Records` already
provides hardened atomic-file primitives; reuse them rather than importing
Harness's private catalog or creating a generic resource layer.

## Implementation Approach

1. Replace the process-local journal representation with one versioned,
   bounded Docker-private persisted journal below the existing root. Keep the
   journal's provider names and labels private; public inventory exposes only
   the approved opaque summaries.
2. Serialize read-modify-write journal transitions across adapter instances
   sharing the root. Persist provision intent, revocation and purge progress
   before the corresponding Docker side effect; persist confirmed deletion
   afterwards.
3. Fail closed for absent/malformed/older journal data and never discover,
   adopt, delete or recreate provider resources based only on Docker labels.
   Existing resource records remain the sole deletion authority.

## Decision Ledger

The public owner, scope, selectors, resource states, purge results, errors,
bounded options and package boundary are frozen by the cited specifications.
An implementer may choose only the private record layout and focused helper
placement needed to reuse `Records` safely. Any need for a new public option,
database, daemon, provider query fallback or contract change is a blocker.

## Action Plan

1. Read the cited contracts, current `Records`, lifecycle, ownership and
   administration code; record the dirty baseline and the exact restart gap.
2. Write the restart/cancellation/metadata-corruption contract tests first.
   Use the scripted transport; no Docker engine, image pull or publication is
   needed for this ticket.
3. Keep all journal persistence under the configured Docker metadata root.
   Use versioned strict parsing, atomic replacement and locking consistent with
   `Records`; do not introduce raw owner-derived filenames or host paths.
4. Rewire lifecycle and administration through the durable journal. Preserve
   the current bounded catalog and idempotency rules exactly, including
   selector barriers and retryable `cleanup_pending` results.
5. Verify package type/test/isolated-consumer checks, inspect error and summary
   projection for provider references, then hand off for independent review.

## Test-First Order

Create one resource with adapter A and inspect/list/attach it through adapter B
with the same root. Start a purge whose first delete fails or is cancelled, then
resume the same idempotency key through B and assert the cumulative count and
remaining set. Purge a principal/tenant, restart, and prove matching owner
creation/attachment is denied. Corrupt or downgrade the journal and assert
state loss/configuration failure before Docker mutation. Assert public errors,
pages and package-consumer output contain neither a Docker name, volume name,
label nor path.

## Requirements Traceability

- REQ-SOWN-OWNER -> CAP-SOWN-OWNER -> PATH-SOWN-OWNER -> ACC-SOWN-OWNER.
- REQ-SOWN-ADMIN -> CAP-SOWN-ADMIN -> PATH-SOWN-ADMIN -> ACC-SOWN-ADMIN.
- REQ-SOWN-BOUNDS -> CAP-SOWN-BOUNDS -> PATH-SOWN-BOUNDS -> ACC-SOWN-BOUNDS.

## Contract Traceability

- `CTR-SOWN-OWNER` supplies registration and state-loss semantics.
- `CTR-SOWN-ADMIN` supplies exact selectors, opaque summaries and durable,
  idempotent purge progress.

## Spec Drift Controls

Pinned source digest: `sha256:9578b59d21602ef020997d76a876d99df6e98728ea41834c8fd981c0d38e0acb`.
Forbidden interpretations: Docker label discovery as authority, a process-local
restart fallback, empty replacement state, public provider references,
unbounded inventory, a shared catalog package or a public migration path. An
implementer stops if the existing root cannot safely hold the private journal.

## Generator And Type Plan

There is no generator for Docker-private records. Reuse strict public DTO
schemas from the package dependency and handwritten private record validation;
compiler declarations and the Docker typecheck are the drift checks. No copied
Harness DTO, `any`, unchecked cast or generated declaration edit is allowed.

## Modularity And Reuse Plan

Keep persistence and locking with `records.ts`; keep ownership indexing and
selector rules in `ownership.ts`; keep operator operations in
`administration.ts`; lifecycle retains only provider side effects. Reuse public
Harness contracts through package exports and Docker's existing scripted
transport. Do not copy `PrivateSandboxCatalog`, create a shared package, or
extend PURISTA/Harness session code.

## Representation Reuse Plan

Reuse `sown.owner`, `sown.scope` and `sown.administration` from the approved
representation catalog. The journal is private persistence, not a public
representation or another mapping contract.

## Slice Strategy

This is a horizontal foundation correction: it produces a restart-safe private
catalog prerequisite for the later atomic port cutover, but adds no second
runtime contract or releasable provider feature.

## Tasks

1. Add the restart and fail-closed tests before persistence changes.
2. Persist exactly the current private catalog authority under the existing root.
3. Rewire lifecycle and administration to that authority and prove restart-safe
   revocation/purge behavior through the public adapter facade.

## Acceptance

All frontmatter acceptance rows must pass for this ticket's contribution. This
ticket does not accept TICKET-004 or any provider adapter.

## Acceptance Test Matrix

| Local acceptance | Canonical proof | Test files |
| --- | --- | --- |
| AC-TICKET-014-RESTART | ACC-SOWN-OWNER | ownership.test.ts, docker.test.ts |
| AC-TICKET-014-PURGE | ACC-SOWN-ADMIN | administration.test.ts |
| AC-TICKET-014-BOUNDARY | ACC-SOWN-BOUNDS | ownership.test.ts, administration.test.ts |

## End-To-End Definition Coverage

The trusted adapter application is the consumer; `DockerSandbox` is the
reachable entrypoint. The journal owns creation state, selector barriers and
cleanup progress; Docker calls are the side effect. Exact owner/actor admission,
state loss, bounded capacity, content-free errors and opaque administration are
the recovery/safety constraints. There is no client or frontend surface.

## Operational Path Coverage

Cover restart after resource allocation, restart after revoke, restart after
partial purge, cancellation, provider deletion failure, malformed metadata and
isolated package import. No live Docker engine is required for those tests.

## Review And Verification Plan

Review against CTR-SOWN-OWNER/ADMIN, this ticket and the exact tests. Reject a
solution that treats a fresh process-local map as authority, uses Docker label
listing as discovery, leaks provider references, weakens bounded admission, or
adds a second public interface. Independent review—not the implementer—decides
acceptance.

## Verification

- CMD-BASELINE records the dirty worktree without changing it.
- CMD-DOCKER_TEST runs hermetic restart, purge and metadata tests.
- CMD-DOCKER_TYPES proves only public Harness imports are used.
- CMD-PACKAGE proves isolated package consumption.

## Non-goals

No E2B/Daytona adapter, Docker image pull, live-engine test, checkpoint restore,
workspace catalog, retention policy expansion, Harness private import, daemon,
database, public migration path, or package publication.

## Handoff

Return the restart-proof test names and counts, package-boundary result, changed
paths and any unresolved safety issue. This ticket only unblocks TICKET-004;
it does not make the public cutover or a release complete.
