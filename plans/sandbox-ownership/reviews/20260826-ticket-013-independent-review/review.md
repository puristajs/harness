# Implementation Review: sandbox-ownership / TICKET-013

Decision: needs_fixes
Review ID: 20260826-ticket-013-independent-review
Scope: TICKET-013 — offline packed Harness and PURISTA verification prerequisite

## Findings

Five blocking findings are recorded in `findings.yaml`. The runner correctly
fails closed before any scratch work when the approved workspace-local cache is
absent; that is required behavior, not a failure to be worked around. It also
means the actual staged source/public-package path has not been proven in this
worktree and cannot support acceptance yet.

## Path Coverage

| Path | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Missing offline cache | covered | `node ai-harness/scripts/check-purista-sandbox.mjs --mode source` exited 1 before scratch creation | Required fail-closed behavior; no network or install was attempted. |
| Scratch containment / normal cleanup | partial | six runner tests pass | Covers success cleanup and lexical escapes only; failure evidence and cleanup-failure handling are absent. |
| Packed Harness binding | partial | `assertInstalledHarness` tests reject stale version/tarball | No successful staged source run is available because cache inputs are intentionally absent. |
| Source-alias rejection | partial | helper unit test | The helper is never called by the runner when copying fixtures, so it does not enforce the fixture contract. |
| Child failure / cancellation | partial | helper-level test | The top-level runner never passes its `signal` to build/install/compile/test child commands. |
| Offline package commands | partial | install commands carry offline/cache flags | `npm pack` uses the ambient npm cache/configuration and has no explicit offline protection. |
| Framework consumer/docs modes | unproven | static trace only | Cache prerequisite correctly prevents execution; no source alias fallback was used to mask this. |

## Digest And Impact Evidence

- Spec digest: `sha256:9578b59d21602ef020997d76a876d99df6e98728ea41834c8fd981c0d38e0acb` — matches the approved spec manifest.
- Current plan digest: `sha256:8670786e09d95437637dbfb7fdb3d45a6d6a4a51e8a088febf45cea32ec703cf`.
- TICKET-013 evidence pins `sha256:525d3ec4a0a8f88ca85d5c3a041ab01bd3d7d9f1bd4e31ab6ede08e5ab022e98`, not the current plan digest, and uses checker-invalid artifact/disposition/status values.
- Impacted consumers are the Wave 3 port cutover and Wave 11 release gate. They must not rely on the runner until the strict packed proof is real and its evidence is valid.

## Verification

| Command | Result | Evidence |
| --- | --- | --- |
| `node --test ai-harness/scripts/check-purista-sandbox.test.mjs` | passed | 6/6 tests passed. |
| `node --check ai-harness/scripts/check-purista-sandbox.mjs` | passed | Syntax check passed. |
| `node --check ai-harness/scripts/check-sandbox-packages.mjs` | passed | Syntax check passed. |
| `node ai-harness/scripts/check-purista-sandbox.mjs --mode source` | expected blocking failure | Missing `ai-harness/.sandbox-verification/npm-cache`; exits before scratch creation. No cache was created or network/install attempted. |
| spec readiness checker | passed | Nested spec check passed. |
| nested plan checker | passed | Nested plan check passed. |
| implementation-evidence checker | failed | It assumes flat root manifests, and separately reports TICKET-013's invalid kinds/disposition/status. The TICKET-013 evidence errors are independently confirmed by its JSON fields. |
| `git -C ai-harness diff --check` | passed | No whitespace errors in the reviewed source. |

## Self-Audit

- Assumptions: the explicitly absent local cache is deliberate and must remain a preflight blocker; this review did not provision it or use network access.
- Skipped checks: successful source, consumer, and docs executions cannot run without that approved cache. Docker/hosted providers and runtime adapter behavior are out of this ticket's scope.
- Unreviewed paths: a real prepopulated-cache run is required after the listed corrections to prove staged resolution, strict consumer declarations, and docs build behavior.
- Residual risk: accepting this ticket would let later tickets claim a public-package proof that currently lacks failure-artifact retention, cancellation coverage, full command isolation, valid evidence, and a successful staged run.
