# Implementation Review: sandbox-ownership / TICKET-013 compliant-engine proof

Decision: pass
Review ID: 20260827-ticket-013-compliant-engine-review
Scope: TICKET-013 follow-up proof under the declared PURISTA Core engine

## Findings

No blocking findings remain. REVIEW-013-006 is resolved: the verification
contract requires a runtime satisfying Core's declared `engines.node`, not the
desktop shell's arbitrary default Node binary. The host already provides Node
`v24.15.0`; executing the exact verifier through that runtime neither installs
nor downloads anything and preserves `engine-strict=true`.

The portable project requirement is unchanged: contributors and CI must select
any Node runtime satisfying `@purista/core`'s declared `>=24.15.0` before
running `node ai-harness/scripts/check-purista-sandbox.mjs --mode source`.
The ticket must not add an engine override, relax the declared requirement, or
encode a Codex/FNM-specific invocation into the public command.

## Path Coverage

| Path | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Compliant runtime selection | covered | `fnm exec --using 24.15.0 -- node --version` returned `v24.15.0` | This is an existing host runtime, not provisioning. |
| Harness package build/pack | covered | Source run built and packed `@purista/harness@3.0.0` afresh | Build/pack occurs at the exact package directory under explicit offline/cache command policy. |
| Offline staged Core install | covered | Source run installed 102 packages under `ai-harness/.sandbox-verification/npm-cache` | The staged manifest binds Harness with a local `file:` tarball. |
| No stale/registry/source Harness fallback | covered | Runner validates staged installed manifest and staged lock resolution to the fresh tarball | Fixtures use only the public `@purista/harness` entrypoint. |
| Core typecheck and selected tests | covered | Staged source run completed; Vitest reports 1 file and 23/23 tests passed | The required `test/service` fixture copy supports this selected Core test. |
| Failure/cancellation/offline guards | covered | 10/10 runner tests passed | Covers cache absence, alias denial, tarball provenance, cleanup evidence, and cancellation. |
| Plan/evidence state | covered for TICKET-013 | Nested spec and plan checks pass; TICKET-013 pins current plan digest | Generic evidence checker remains incompatible with the nested manifest layout and sibling accepted records, but reports no TICKET-013 field violation. |

## Digest And Impact Evidence

- Spec digest: `sha256:9578b59d21602ef020997d76a876d99df6e98728ea41834c8fd981c0d38e0acb`.
- Plan digest and TICKET-013 evidence digest:
  `sha256:b205ca34465c6a1d794dda327b931b0634b8f0ba9b5c4a0285db8bda5d69b7dc`.
- Reviewed downstream consumers: Wave 3 `TICKET-004` and Wave 11 `TICKET-012`.

## Verification

| Command | Result | Evidence |
| --- | --- | --- |
| `fnm exec --using 24.15.0 -- node --test ai-harness/scripts/check-purista-sandbox.test.mjs` | passed | 10/10 tests passed. |
| `fnm exec --using 24.15.0 -- node ai-harness/scripts/check-purista-sandbox.mjs --mode source` | passed | Fresh local Harness build/pack, offline staged install, Core typecheck, and 23/23 selected tests passed. |
| `node --check` on both verifier scripts | passed | Syntax checks passed. |
| nested spec readiness checker | passed | Approved spec validation passed. |
| nested plan checker | passed | Plan validation passed. |
| `git -C ai-harness diff --check` | passed | No whitespace errors. |

## Self-Audit

- Assumptions: Node `v24.15.0` remains locally installed and is selected by the
  developer/CI runtime manager; no FNM-specific behavior is part of the product
  contract.
- Skipped checks: strict packed consumer and docs modes are intentionally
  deferred release gates; Docker/provider runtime behavior is out of scope.
- Unreviewed paths: none required for this ticket's source-proof acceptance.
- Residual risk: release remains separately blocked on TICKET-012's strict
  consumer declaration prerequisites, as specified.
