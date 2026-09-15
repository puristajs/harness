# Implementation Review: sandbox-ownership / TICKET-001

Decision: needs_fixes
Review ID: 20260826-ticket-001-independent-review
Scope: TICKET-001 closed ownership and administration contract foundation.

## Findings

Four blocking findings are recorded in `findings.yaml`. The implementation has
the intended package boundary and does not change the live Sandbox port, but its
public validation and test wiring are not yet safe to accept.

## Path Coverage

| Path | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Closed owner input | blocked | `sandboxOwnerSchema` accepts `Z1JQ7Z9Q69STZ33MGH6V5ASR7J` | A 26-character Crockford string with an out-of-range first character is not a canonical ULID. |
| Closed session/policy input | blocked | `SessionOptions` is handwritten without a strict source schema | The only handwritten exception is for function-bearing or capability-generic contracts. |
| Administrative summary validation | blocked | `sandboxResourceSummarySchema` accepts `kind: 'workspace'` with `scope` | The contract permits scope only for sandbox and optional snapshot source scope. |
| Safe public error projection | blocked | serialized quota error retains a supplied `owner: 'SENTINEL'` member | Error metadata must be closed and identity-free at runtime, including JavaScript callers. |
| Contract-test execution | blocked | `vitest.config.ts` omits `src/sandbox/**/*.test.ts` | The ticket's new ownership and administration tests are not part of `CMD-HARNESS_UNIT`. |
| Existing live Sandbox port | reviewed | `src/sandbox/index.ts`, root exports, TICKET-004 | Ticket keeps the new scope private and does not add a runtime compatibility port. |

## Digest And Impact Evidence

- Readiness/spec digest: `sha256:9578b59d21602ef020997d76a876d99df6e98728ea41834c8fd981c0d38e0acb`; scoped spec checker passed.
- Plan digest at review start: `sha256:38239791f017b6eb7463c0e83a8a0c3803380b646f9992bcb06f7df65197bbab`; nested plan checker passed before lifecycle handoff changes.
- Changed assets reviewed: `sown.owner`, `sown.scope`, `sown.policy`, `sown.administration`, `sown.options`, and `sown.safe-error` in the evidence manifest.
- Consumers reviewed: root `@purista/harness` exports, public-api export lock, type test, current live sandbox port, and scheduled TICKET-004/006/009 consumers. No runtime consumer is wired by this foundation ticket.

## Verification

| Command | Result | Evidence |
| --- | --- | --- |
| `check_specs.mjs ai-harness/specs/36-sandbox-ownership-and-administration` | passed | Scoped approved feature spec verified. |
| `check_plan.mjs . ai-harness/plans/sandbox-ownership ai-harness/specs/36-sandbox-ownership-and-administration` | passed before handoff edits | Nested plan structure and pinned digests were valid. |
| `check_implementation_evidence.mjs ai-harness` | expected tooling limitation | Fails only because the generic checker assumes root-level `specs/spec-manifest.yaml` and `plans/plan-manifest.yaml`; nested evidence JSON was inspected manually. |
| `npm --prefix ai-harness run typecheck --workspace @purista/harness` | passed | Harness source compiles. |
| `npm --prefix ai-harness run build --workspace @purista/harness` | passed | Compiler declaration build completes. |
| `npm --prefix ai-harness run test:types` | passed | Public type tests compile. |
| `npm --prefix ai-harness run test:unit --workspace @purista/harness` | environment-blocked and insufficient | 269 tests passed; four existing HTTP MCP tests failed only because this environment denies `listen` on `127.0.0.1`. The new `src/sandbox` tests are omitted from Vitest discovery regardless. |
| Direct built-schema probes | failed as recorded | Reproduced ULID, workspace-scope, and serialized-error defects without network or external writes. |
| `git -C ai-harness diff --check` | passed | No whitespace error. |

## Self-Audit

- Assumptions: canonical ULID follows the 128-bit ULID range, whose first
  Crockford base32 character is `0` through `7`; this also matches the existing
  `ulid()` producer.
- Skipped checks: full unit suite cannot be green in this sandbox because it
  cannot bind the existing MCP test listener. No external Docker/provider check
  is applicable to this foundation ticket.
- Unreviewed paths: no later catalog/runtime/PURISTA behavior is claimed here;
  those tickets remain planned.
- Residual risk: the current root export test only locks value exports, and the
  type test does not prove JavaScript runtime input closure. The blocking tests
  below must be added before acceptance.
