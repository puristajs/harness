# T004/T010 — final core boundary reuse cleanup

Coordinator-authorized bounded repair after read-only CTR-DB-CLEANUP review.
No addon, provider, sandbox, storage implementation, package manifest, or build
output was modified by this slice.

## T004 shared interceptor result

- `agents/index.ts` validates allow/block with canonical `decisionResultSchema`.
  Its private transform schema extends that schema's base, retaining the shared
  reason-code definition. It still requires an own `value`, rejects unknown
  keys, honors transform allowance per phase, and leaves phase/value validation
  and `invalid_result` versus `invalid_transform` classification unchanged.
- `AgentInterceptorDecision` is inferred from the canonical schema.
  `AgentInterceptorTransform<T>` reuses the inferred non-discriminant fields;
  it does not declare a second reason-code property type.
- Expanded the existing malformed-result test into a seven-row matrix for
  invalid reason codes, extra allow/block/transform fields, and missing value.
  All 55 interceptor tests passed before and after the pure reuse change.
  Existing tests cover explicit undefined transform and phase-specific guards.

## T010 mechanical cleanup

- Removed `agents/index.ts`'s orphan `runLimited` helper and its obsolete
  `test/run-limited.test.ts`. Repository search confirmed no production
  consumers after `runPreparedToolBatch` replaced its lifecycle. The prepared
  batch tests remain and cover ordering, concurrency, cancellation, and effects.
- `PermissionMode`, `PermissionPolicy`, and `AgentPermissions` now derive from
  canonical permission schemas. Private mode/exposure schemas eliminate repeated
  enums within those owners. Permission arrays remain readonly through schema
  readonly declarations; field descriptions remain at the schema owner.
- `GovernanceMode`, `GovernanceEffect`, and `GovernanceExposureEffect` derive
  from their existing config/result schema, not manually repeated literal unions.
- `RunEvent`'s `external_wait.resolved` outcome reuses `ExternalWaitOutcome`.
- Added existing-file type cases preserving readonly permission arrays and
  rejecting the removed permission spelling. These passed both before and after
  alias inference. No compatibility overload, second schema mirror, or new
  public schema/export was introduced.

## Verification

- `npm test --workspace @purista/harness -- test/agent-interceptors.test.ts test/governance.test.ts test/tools.test.ts src/decisions/decisions.test.ts`: **PASS, 4 files / 151 tests**.
- `npm run typecheck --workspace @purista/harness`: **PASS**.
- `npm run test:types --workspace @purista/harness`: **PASS**.
- `git diff --check`: **PASS**.
- `runLimited` source/test scan: **empty** after removal.
- No private addon imports or second decision-id algorithm were found in the
  bounded decision/governance/rail review. The distinct approval-id algorithm
  follows its separately defined occurrence/demand tuple.

One additional tiny model-check schema duplication in addon `rails.ts` was
reported to its exclusive owner: request JSON generation and response parsing
should share the same strict `{ allow: boolean }` schema. That owner's repair
and global package builds/audits remain coordinator-owned gates, not claimed
by this evidence. No broad suite or build was run by this slice.
