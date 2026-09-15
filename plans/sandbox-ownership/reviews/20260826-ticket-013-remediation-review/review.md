# Implementation Review: sandbox-ownership / TICKET-013 remediation

Decision: needs_fixes
Review ID: 20260826-ticket-013-remediation-review
Scope: Independent remediation review of TICKET-013

## Findings

REVIEW-013-001 through REVIEW-013-004 are fixed in the scoped implementation:

- failed operations now write bounded content-free evidence, retain the original
  failure when cleanup also fails, and test the exact scratch boundary;
- the runner threads its signal through guarded build, pack, install, compiler,
  test, and docs commands, with a runner-level cancellation test;
- pack/install commands use explicit `--offline` and workspace-local `--cache`
  arguments through one helper; and
- fixture staging invokes the public-entrypoint validation and rejects a private
  Harness subpath before copying.

REVIEW-013-005 remains blocking. The evidence now pins the exact current nested
plan digest, but it still contains checker-invalid artifact kinds, consumer
disposition, and architecture-check status. No code was changed in this review.

The intentionally absent workspace-local npm cache still fails source mode
before creating a scratch directory. That behavior is correct and was not
worked around; it prevents a successful staged public-package run in this
worktree, so acceptance must also await an explicitly prepopulated cache and
the required source proof.

## Path Coverage

| Path | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Missing offline cache | covered | source command exits 1 before scratch creation | Required fail-closed behavior; no cache, network, or install was introduced. |
| Failure evidence / cleanup | covered | runner test preserves original child error and records content-free incomplete-cleanup evidence | Only the exact `run-*` child is removed. |
| Cancellation | covered | runner-level injected build step aborts before source mode starts | Static trace confirms signal is passed to all guarded child commands. |
| Offline cache / package commands | covered | unit test asserts common npm argument builder for install and pack | Pack and build/package children now use the guarded helper. |
| Public fixture imports | covered | private Harness subpath fixture is rejected before staging | No source alias/shim is added. |
| Packed Harness source proof | blocked by required local input | source command stops at missing local cache | Do not provision/fetch automatically; rerun only after authorized cache prepopulation. |
| Evidence manifest | blocked | implementation-evidence checker rejects TICKET-013 fields | Current digest is correct; schema values remain invalid. |

## Digest And Impact Evidence

- Spec digest: `sha256:9578b59d21602ef020997d76a876d99df6e98728ea41834c8fd981c0d38e0acb`.
- Current plan digest and TICKET-013 evidence digest:
  `sha256:8670786e09d95437637dbfb7fdb3d45a6d6a4a51e8a088febf45cea32ec703cf`.
- Affected consumers remain Wave 3 `TICKET-004` and Wave 11 `TICKET-012`; neither receives an accepted packed-proof guarantee yet.

## Verification

| Command | Result | Evidence |
| --- | --- | --- |
| `node --test ai-harness/scripts/check-purista-sandbox.test.mjs` | passed | 10/10 tests passed. |
| `node --check ai-harness/scripts/check-purista-sandbox.mjs` | passed | Syntax check passed. |
| `node --check ai-harness/scripts/check-sandbox-packages.mjs` | passed | Syntax check passed. |
| `node ai-harness/scripts/check-purista-sandbox.mjs --mode source` | expected blocking failure | Missing workspace-local cache; no scratch root was created. |
| nested spec readiness checker | passed | Approved spec validation passed. |
| nested plan checker | passed | Plan validation passed. |
| implementation-evidence checker | failed | Flat-layout manifest messages are a known nested-plan tool limitation; TICKET-013's invalid kinds/disposition/status are direct unresolved failures. |
| `git -C ai-harness diff --check` | passed | No whitespace errors. |

## Self-Audit

- Assumptions: no cache prepopulation or network access is authorized by this ticket; its absence must remain a blocker.
- Skipped checks: source/consumer/docs success execution awaits the explicit local cache input. Docker/provider runtime checks are out of scope.
- Unreviewed paths: actual staged source binding and strict consumer declarations after cache provision.
- Residual risk: accepting with invalid implementation evidence would break the approved traceability gate; accepting without the staged source run would overstate external-package proof.
