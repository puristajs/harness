# Capability inventory

Actors are application developers, package/adapter maintainers, documentation consumers, and release operators. Runtime UI, admin, durable migration, and infrastructure capabilities are absent by applicability.

| ID | Outcome | Owner | Entry | Contracts |
| --- | --- | --- | --- | --- |
| CAP-SS-TYPES | Vendor-neutral schema declarations with exact nested inference | harness core | package exports and builders | CTR-SS-SCHEMA, CTR-SS-BUILDERS |
| CAP-SS-VALIDATION | One async, transform-aware, JSON-safe validation path | harness core/guardrails | runtime boundaries | CTR-SS-VALIDATION, CTR-SS-ERRORS |
| CAP-SS-PROJECTION | Build-time model JSON Schema projection and cache | harness core | `build()` | CTR-SS-PROJECTION, CTR-SS-ERRORS |
| CAP-SS-PROVIDERS | Exact JSON Schema provider pass-through | adapter maintainers | model provider port | CTR-SS-PROVIDERS |
| CAP-SS-CONSUMERS | Aligned specs, docs, examples, skills and website | docs/skills maintainers | existing public surfaces | CTR-SS-CONSUMERS |
| CAP-SS-CLEANUP | Clean breaking cut with no public Zod legacy path | release maintainer | source audits and CI | CTR-SS-CLEANUP |

## Acceptance

- **AC-SS-TYPES-SUCCESS:** Zod, ArkType and Valibot type fixtures compile; nested input/output, transforms, alias registries, `$infer`, contexts and session methods are exact.
- **AC-SS-TYPES-FAILURE:** Negative fixtures reject non-schema values, validation-only schemas at model boundaries, non-JSON transforms, wrong nested values and cross-alias arguments.
- **AC-SS-TYPES-RECOVERY:** Supplying a conforming schema/projection or correct inferred value compiles without casts or annotations.
- **AC-SS-VALIDATION-SUCCESS:** Sync/async schemas and transforms yield validated output exactly once at every listed boundary.
- **AC-SS-VALIDATION-FAILURE:** Issues, throws/rejections and non-JSON success values map to fixed privacy-safe errors; callbacks/provider/persistence do not execute after failure.
- **AC-SS-VALIDATION-RECOVERY:** A later valid invocation on the same built Harness succeeds with no leaked state or cached failure.
- **AC-SS-PROJECTION-SUCCESS:** Each tool input/default-loop output converter runs once at build, receives Draft 2020-12 input mode, and yields a recursively frozen `JsonValue` reused across runs/retries.
- **AC-SS-PROJECTION-FAILURE:** Missing, throwing or invalid projection fails build with the exact closed error reason/boundary/id/target metadata and no vendor content.
- **AC-SS-PROJECTION-RECOVERY:** Rebuilding with a valid `ModelSchema` succeeds; no partial Harness from the failed build is runnable.
- **AC-SS-PROVIDERS-SUCCESS:** Every first-party adapter request contains a schema deeply equal to the core-provided JSON value, including distinctive nested keywords.
- **AC-SS-PROVIDERS-FAILURE:** Provider rejection uses existing model error mapping and no adapter silently mutates/retries with a weakened schema.
- **AC-SS-PROVIDERS-RECOVERY:** An explicitly provider-compatible user schema succeeds without changing core validation semantics.
- **AC-SS-CONSUMERS-SUCCESS:** Specs, package docs, examples, Harness skill, PURISTA handbook/site and canonical skills state the same boundary matrix and all snippets compile/build.
- **AC-SS-CONSUMERS-FAILURE:** Link, snippet, skill-sync, knowledge and terminology audits fail on stale Zod-only or inaccurate projection guidance.
- **AC-SS-CONSUMERS-RECOVERY:** Correcting the canonical source and regenerating existing mirrors makes all audits pass; no manual mirror-only fix is accepted.
- **AC-SS-CLEANUP-SUCCESS:** CI and source audits pass with one runtime path, no public Zod constraints, no casts of validator objects to JSON Schema, and unchanged internal Zod uses outside scope.
- **AC-SS-CLEANUP-FAILURE:** Compatibility aliases/overloads, vendor switches, skipped/fake tests, TODOs, widened declarations or migration code fail acceptance.
- **AC-SS-CLEANUP-RECOVERY:** Delete the legacy/fake path and implement the canonical contract; waivers and deprecations are not a valid recovery.
