# Operations and release runbook

## Build and verification order

1. Install the locked dependency graph with the repository package manager.
2. Run Harness architecture checks, typecheck, declaration build, runtime tests, coverage, type tests, contract/integration/failure suites.
3. Run every first-party provider package typecheck/test and the quickstart/example compile tests.
4. Run Harness skill sync and verify no unexplained generated drift.
5. In `purista`, run relevant package/docs builds plus `npm run audit:skills` and `npm run audit:knowledge`.
6. Run the forbidden-pattern and scoped-diff audits in `CTR-SS-CLEANUP`.

No secrets or live providers are used. Fake SDK seams capture outbound requests.

## Release

Publish as a breaking Harness release because public schema generic constraints and inferred declaration shapes change. Release the aligned adapter packages/docs/skills/site together. The release note states the new current contract and minimum model-schema vendor versions; it does not add compatibility or migration code.

## Failure diagnosis

- Build reason `schema_json_projection_missing`: the model-facing schema validates but does not implement Standard JSON Schema.
- `schema_json_projection_failed`: the vendor cannot represent this schema/target; simplify the schema or use a supported converter.
- `schema_json_projection_invalid`: converter returned non-JSON data; fix/replace it.
- `schema_validation_execution_failed`: validator threw instead of returning issues; fix the validator/schema.
- `schema_validation_non_json`: schema transform returned a value Harness cannot persist/send; return JSON.
- Provider rejection after successful build: use a schema subset supported by that provider; core must not rewrite it.

## Rollback

Rollback is package/site version rollback to the preceding release, not an in-code compatibility switch. No data rollback is required because persistent shapes do not change. Re-run prior-version smoke/type tests before restoring traffic or documentation links.
