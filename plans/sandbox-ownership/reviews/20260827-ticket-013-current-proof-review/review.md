# Implementation Review: sandbox-ownership / TICKET-013 current proof

Decision: needs_fixes
Review ID: 20260827-ticket-013-current-proof-review
Scope: TICKET-013 verifier, fixtures, evidence, and nested plan status

## Findings

The prior script fixes remain valid: packaging runs from the exact Harness/Core
package directory, each npm child is explicitly offline and bound to the
workspace-local cache, staging uses a `file:` Harness tarball and validates the
installed package plus staged lockfile, and the required service test fixtures
are copied with Core. Runner tests pass 10/10.

However, the required `CMD-SOURCE` does **not** pass in the current workspace.
It builds and packs local Harness, then the offline staged install rejects Core
because this host runs Node `v24.3.0`, while `@purista/core@3.2.4` requires
`>=24.15.0` and npm has `engine-strict=true`. The implementation correctly
fails closed; provisioning, disabling engine checks, or using a registry/source
fallback would violate the ticket. The status and evidence currently claim a
successful 23-test source proof without a reproducible matching-engine record,
so this ticket cannot be accepted.

## Path Coverage

| Path | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Harness package build/pack | covered | `buildAndPackHarness` uses `packages/harness` cwd and `packPackageDirectory` | Normal Harness build output is the only non-scratch build effect permitted by the ticket. |
| Offline/cache authority | covered | `npmVerificationArguments` is used for build, pack, and install; 10 runner tests pass | No registry Harness fallback or source alias is present. |
| Staged Core/public binding | partial | Code stages `file:` tarball and checks installed manifest + lockfile | Current actual run stops at engine validation before this proof can execute. |
| Staged selected tests | blocked | `CMD-SOURCE` ends during staged npm install | Core typecheck and selected AgentQueueBuilder tests never start. |
| Required fixture/service inputs | covered | `stageCoreSource` copies `packages/core`, three configs, and `test/service` | Copy remains within ticket read scope; no `.env`, `.git`, dist, or node_modules is copied on the staged Core path. |
| Evidence/plan state | partial | nested plan check passes and TICKET-013 digest matches current plan | Status/evidence assert a source success contradicted by the required command in this environment. |

## Digest And Impact Evidence

- Spec digest: `sha256:9578b59d21602ef020997d76a876d99df6e98728ea41834c8fd981c0d38e0acb`.
- Current nested plan digest and TICKET-013 evidence digest:
  `sha256:b205ca34465c6a1d794dda327b931b0634b8f0ba9b5c4a0285db8bda5d69b7dc`.
- TICKET-013's evidence schema fields are now valid. The generic evidence
  checker still expects flat root manifests and rejects already-accepted sibling
  records; it reported no TICKET-013 schema error in this review.
- Wave 3 `TICKET-004` and Wave 11 `TICKET-012` must continue to treat this
  package proof as unavailable.

## Verification

| Command | Result | Evidence |
| --- | --- | --- |
| `node --test ai-harness/scripts/check-purista-sandbox.test.mjs` | passed | 10/10 tests passed. |
| `node ai-harness/scripts/check-purista-sandbox.mjs --mode source` | failed closed | Harness builds/packs, then staged offline install exits 1 with `EBADENGINE`: Node `v24.3.0` is below Core's `>=24.15.0` engine. |
| `node --check` on both verification scripts | passed | Both syntax checks passed. |
| nested spec readiness checker | passed | Approved spec validation passed. |
| nested plan checker | passed | Plan validation passed. |
| implementation evidence checker | failed for known global layout/sibling reasons | No remaining TICKET-013 field failure; checker lacks nested-manifest support. |
| `git -C ai-harness diff --check` | passed | No whitespace errors. |

## Self-Audit

- Assumptions: the host's `engine-strict=true` and Core's declared engine are
  authoritative; no engine override, installation, cache mutation, or registry
  access is permitted to manufacture a pass.
- Skipped checks: typecheck and 23 selected staged tests cannot run until a
  Node version satisfying Core's declared engine is provided.
- Unreviewed paths: successful source/consumer/docs runs under a compliant
  engine remain required before release proof.
- Residual risk: accepting on the current status would falsely claim the
  exact public-package verification that the ticket exists to establish.
