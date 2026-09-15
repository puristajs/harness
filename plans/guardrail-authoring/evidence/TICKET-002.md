# TICKET-002 — Inline configuration clean cut

Recorded implementation: 2026-08-26. Status: **implemented; not accepted**.
Independent review controls acceptance and any lifecycle promotion.

## Scope and contract trace

Implemented `CTR-GA-CONFIG`, `CTR-GA-GENERATION`, `CTR-GA-ERRORS`, and
`REQ-GA-CONFIG` in the ticket write scope.

- Kept `guardrailsConfigSchema` as the single canonical Zod schema and its
  derived `GuardrailsConfigInput`/`GuardrailsConfig` types.
- Added `GuardrailsConfigFor<A>` and generic `defineGuardrails<const A>` so
  each phase's inline flow IDs are statically limited to the declared actions
  for that phase; the configuration cannot influence action inference.
- Made inline `defineGuardrails({ config, actions })` the only public and
  runtime configuration path. Parsing, JSON-value validation, cloning, and
  freezing occur privately during guardrail compilation.
- Deleted `config.ts`, `loadGuardrailsConfig`, `parseGuardrailsConfig`,
  `ParsedGuardrailsConfig`, the YAML package dependency for this workspace,
  file-related error reasons, schema-package export, generated schema and
  reference, generator script, and configuration scripts.
- Updated the runnable example, public exports, tests, type tests, package
  metadata, README, and lockfile workspace metadata. No compatibility alias,
  fallback parser, file scan, or legacy config vocabulary remains.
- Added inline success, malformed-input, hostile-object, corrected-input, and
  immutable-compilation regression coverage. Invalid JavaScript metadata is
  normalized to the fixed `invalid_shape` surface without Zod diagnostics.
  Type tests reject misspelled flow IDs and cross-phase action bindings. The
  generated-artifact checks were removed because no generated configuration
  artifact exists.

Unrelated workspace YAML dependencies and YAML-backed specification files were
not changed. Voyage was not read or changed.

## Acceptance mapping

| Acceptance ID | Evidence |
| --- | --- |
| `AC-GA-CONFIG-SUCCESS` | Direct TypeScript configuration compiles through `defineGuardrails`; the example uses no parser; `rails` defaults through the canonical schema. |
| `AC-GA-CONFIG-FAILURE` | Unit tests reject unknown/legacy fields and hostile values with the fixed `invalid_shape` error surface. |
| `AC-GA-CONFIG-RECOVERY` | Unit tests prove a corrected inline declaration builds after a failed one and that later mutation cannot change compiled rails. |

## Verification

- Scoped spec checker: passed.
- Package build: `npm run build --workspace @purista/harness-guardrails` passed.
- Package tests: `npm test --workspace @purista/harness-guardrails` passed: 40 tests.
- Package type tests: `npm run test:types --workspace @purista/harness-guardrails` passed.
- Exact removal scan in package/example scope: passed; no file-surface term or
  configuration artifact remained.
- `git diff --check`: passed.
- Root `npm run build` compiled this package successfully but ended nonzero
  because the unrelated native-privacy workspace's `napi build` could not spawn
  under the local sandbox (`EPERM`). This is an environment verification
  limitation, not a guardrails build failure.

## Review focus

Verify that the private compiler remains the sole normalization boundary and
that no later ticket restores a file configuration surface, compatibility alias,
or generated configuration artifact.
