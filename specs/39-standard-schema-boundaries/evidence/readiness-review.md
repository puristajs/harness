# Readiness review evidence

Review date: 2026-08-28. Source baseline: `74838ca875cb55df016f0ee47a9e5da569207823` plus preserved working tree.

## Research and source inspection

- [Standard Schema](https://standardschema.dev/schema) defines the structural validation interface, associated input/output types, issue result, and sync-or-async validation.
- [Standard JSON Schema](https://standardschema.dev/json-schema) explicitly separates projection from validation, defines input/output converters and target handling, documents converter throws, recommends Draft 2020-12, and gives the combined-interface pattern used by `ModelSchema`.
- The same official compatibility table records Zod 4.2+, ArkType 2.1.28+, and Valibot 1.2 with `@valibot/to-json-schema` 1.5+.
- [Zod JSON Schema documentation](https://zod.dev/json-schema) confirms native conversion and input/output projection considerations; installed Zod 4.4 declarations expose `~standard.jsonSchema`.
- Local provider port and adapter inspection confirms the existing contract is plain `JsonValue` JSON Schema. No adapter requires a Zod schema.
- Local runtime inspection found public Zod coupling in definitions/agents/tools/workflows/sessions/guardrails and a concrete memory-summary cast that passes a Zod object where `ObjectRequest.schema` requires JSON Schema.
- `purista/packages/core/src/schema/standardSchema.ts` establishes the canonical PURISTA names and awaited validation approach reused here.

## Checklist walk

- Architecture/structure: ownership and forbidden dependency direction are explicit.
- Contracts/generation: schema types, inference direction, runtime validation, projection, errors, provider pass-through and generated declaration ownership are closed.
- End-to-end/testing: each capability has success/failure/recovery paths and observable acceptance; no live providers.
- Security/privacy: the readiness package lacks the referenced standalone `checklist-secrets-privacy.md`; equivalent required controls are covered explicitly in `CTR-SS-ERRORS` and NFR security/privacy, including issue/cause redaction and secret-free tests.
- Performance/capacity: deterministic converter/validator call bounds, bounded issue handling and frozen cache are measurable.
- Async/integrations: awaits, cancellation checks, atomic build, provider failure/recovery and no lossy retry are specified.
- Data/operations/release: persisted shapes do not change; JSON integrity, release ordering, diagnostics and version rollback are explicit.
- Documentation/consumers: Harness and PURISTA specs/docs/examples/skills/site plus canonical mirror audits are in scope; Voyage is explicitly out.
- Clean break: no compatibility/migration code, no fake/skip/placeholder completion, and precise forbidden scans.

## Semantic review

The design is sufficient because model SDK restrictions occur after the provider-neutral JSON Schema port, not at the validation-library boundary. Requiring projection everywhere would unnecessarily exclude validation-only schemas; allowing validation-only schemas at model boundaries would defer a deterministic build defect to runtime. The two-type contract is the smallest sound split.

Open decisions: none. The repository owner explicitly auto-approved spec creation and a breaking clean refactor with PURISTA naming/type patterns in the initiating task. Implementation and verification remain pending and must follow the content-bound plan.
