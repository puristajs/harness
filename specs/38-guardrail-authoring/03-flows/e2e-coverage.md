# End-to-end requirements and acceptance

Each capability starts from an explicit developer composition or maintainer command and ends in a validated build, protected invocation, or checked documentation artifact. There is no hidden service entrypoint. All identifiers below map reciprocally in 00-traceability.yaml.

## REQ-GA-CALLBACKS

**Actor/entry:** application developer or repository maintainer through schema-directed native tools and callback inference. **Preconditions:** prior tickets accepted, current approved digest, existing locked dependencies. **Contracts:** CTR-GA-CALLBACKS. **Data:** ephemeral definitions/configuration, existing runtime JSON, or public docs; no new persistence. **State:** authored → validated/compiled → built/executed/checked; validation failure produces no partial success. **Permissions:** application-selected registries and existing governance remain authoritative. **Side effects:** only those explicitly assigned in contracts; preflight has none beyond local policy reads. **Observability:** fixed safe errors and existing spec37 evidence; no policy/protected content. **Recovery:** correct declaration/config/artifact and rerun the same entrypoint. **Owner/final state:** ticket owner supplies passing public-interface evidence; independent reviewer accepts.

- **AC-GA-CALLBACKS-SUCCESS:** Helper/captured-map/native-plus-MCP/module registrations preserve exact schemas, registry keys and sandbox capabilities; transformed input/output crosses each parser once.
- **AC-GA-CALLBACKS-FAILURE:** Unknown fields, wrong handler output, files-only exec, unsafe narrow extracted callbacks and raw native objects in either registration form fail typechecking or config validation.
- **AC-GA-CALLBACKS-RECOVERY:** Omitted agent/workflow schemas still default to string; reuse of registered definitions and canonical indexed callback types preserves inferred Harness return types.

Verification: ai-harness/packages/harness/type-tests/harness-typing.ts, ai-harness/packages/harness/test/tools.test.ts, ai-harness/packages/harness/test/harness.test.ts, ai-harness/packages/harness/test/workflow-delegation.test.ts, ai-harness/packages/harness/test/static-modules.test.ts.

## REQ-GA-CONFIG

**Actor/entry:** application developer or repository maintainer through one inline configuration schema. **Preconditions:** prior tickets accepted, current approved digest, existing locked dependencies. **Contracts:** CTR-GA-CONFIG, CTR-GA-GENERATION, CTR-GA-ERRORS. **Data:** ephemeral definitions/configuration, existing runtime JSON, or public docs; no new persistence. **State:** authored → validated/compiled → built/executed/checked; validation failure produces no partial success. **Permissions:** application-selected registries and existing governance remain authoritative. **Side effects:** only those explicitly assigned in contracts; preflight has none beyond local policy reads. **Observability:** fixed safe errors and existing spec37 evidence; no policy/protected content. **Recovery:** correct the inline declaration and rerun the same entrypoint. **Owner/final state:** ticket owner supplies passing public-interface evidence; independent reviewer accepts.

- **AC-GA-CONFIG-SUCCESS:** A literal inline object has action/phase correlation, normalizes defaults, and compiles to the canonical immutable config.
- **AC-GA-CONFIG-FAILURE:** Old metadata/names/keys, unknown fields, non-JSON values, duplicate flows, and invalid policy values fail with safe errors.
- **AC-GA-CONFIG-RECOVERY:** A corrected inline declaration recompiles without cached state; source mutation cannot change a compiled config; removed file APIs/artifacts/dependency/scripts are absent.

Verification: ai-harness/packages/harness-guardrails/test/guardrails.test.ts.

## REQ-GA-REQUIREMENTS

**Actor/entry:** application developer or repository maintainer through provider-neutral interceptor build preflight. **Preconditions:** prior tickets accepted, current approved digest, existing locked dependencies. **Contracts:** CTR-GA-BINDING, CTR-GA-ERRORS. **Data:** ephemeral definitions/configuration, existing runtime JSON, or public docs; no new persistence. **State:** authored → validated/compiled → built/executed/checked; validation failure produces no partial success. **Permissions:** application-selected registries and existing governance remain authoritative. **Side effects:** only those explicitly assigned in contracts; preflight has none beyond local policy reads. **Observability:** fixed safe errors and existing spec37 evidence; no policy/protected content. **Recovery:** correct declaration/config/artifact and rerun the same entrypoint. **Owner/final state:** ticket owner supplies passing public-interface evidence; independent reviewer accepts.

- **AC-GA-REQUIREMENTS-SUCCESS:** Build validates declared model aliases/capabilities and agent-enabled configured tool IDs across direct, helper and static-module registrations.
- **AC-GA-REQUIREMENTS-FAILURE:** Missing/disabled tool, missing alias, missing capability or malformed requirement fails before any callback/session/provider/MCP/sandbox work.
- **AC-GA-REQUIREMENTS-RECOVERY:** Models registered after agents succeed; builtin defaults/false use one resolver; dynamic turn narrowing still cannot expand permissions.

Verification: ai-harness/packages/harness/test/build-validation.test.ts, ai-harness/packages/harness/test/agent-interceptors.test.ts, ai-harness/packages/harness/type-tests/harness-typing.ts.

## REQ-GA-ACTIONS

**Actor/entry:** application developer or repository maintainer through sound action tokens and schema-bound sensitive codecs. **Preconditions:** prior tickets accepted, current approved digest, existing locked dependencies. **Contracts:** CTR-GA-ACTIONS, CTR-GA-CONFIG, CTR-GA-ERRORS. **Data:** ephemeral definitions/configuration, existing runtime JSON, or public docs; no new persistence. **State:** authored → validated/compiled → built/executed/checked; validation failure produces no partial success. **Permissions:** application-selected registries and existing governance remain authoritative. **Side effects:** only those explicitly assigned in contracts; preflight has none beyond local policy reads. **Observability:** fixed safe errors and existing spec37 evidence; no policy/protected content. **Recovery:** correct declaration/config/artifact and rerun the same entrypoint. **Owner/final state:** ticket owner supplies passing public-interface evidence; independent reviewer accepts.

- **AC-GA-ACTIONS-SUCCESS:** Literal action phase and schema output infer in inline and extracted callbacks; heterogeneous tokens compile with phase-constrained configuration; fixed and tool sensitive actions share algorithms.
- **AC-GA-ACTIONS-FAILURE:** Wrong phase target, false-transform, dynamic boolean, forged token, unsafe callback narrowing, missing codec schema and mistyped flow ID fail at their declared validation stage.
- **AC-GA-ACTIONS-RECOVERY:** Existing decisions/evidence/timeouts/transforms remain single-owned; an unrelated tool is skipped before schema/codec/model work while a selected mismatch fails closed.

Verification: ai-harness/packages/harness-guardrails/type-tests/guardrails-typing.ts, ai-harness/packages/harness-guardrails/test/guardrails.test.ts, ai-harness/examples/guardrails/src/index.test.ts.

## REQ-GA-BINDING

**Actor/entry:** application developer or repository maintainer through attach requirements and end-to-end deployment preflight. **Preconditions:** prior tickets accepted, current approved digest, existing locked dependencies. **Contracts:** CTR-GA-BINDING, CTR-GA-ACTIONS, CTR-GA-DOCS. **Data:** ephemeral definitions/configuration, existing runtime JSON, or public docs; no new persistence. **State:** authored → validated/compiled → built/executed/checked; validation failure produces no partial success. **Permissions:** application-selected registries and existing governance remain authoritative. **Side effects:** only those explicitly assigned in contracts; preflight has none beyond local policy reads. **Observability:** fixed safe errors and existing spec37 evidence; no policy/protected content. **Recovery:** correct declaration/config/artifact and rerun the same entrypoint. **Owner/final state:** ticket owner supplies passing public-interface evidence; independent reviewer accepts.

- **AC-GA-BINDING-SUCCESS:** Attached actions emit active-phase requirements; the inline example builds and executes two differently shaped tools with selective protection.
- **AC-GA-BINDING-FAILURE:** Missing model/tool/capability fails build before requests; retrieval checks only retrieval dependencies; schema-incompatible selected payload still fails at invocation with zero protected effects.
- **AC-GA-BINDING-RECOVERY:** Manual core interceptor declarations retain requirements; preflight script calls the real composition then shutdown with zero model/detector/tool invocations; corrected policy can rebuild.

Verification: ai-harness/packages/harness-guardrails/test/guardrails.test.ts, ai-harness/packages/harness-guardrails/type-tests/guardrails-typing.ts, ai-harness/examples/guardrails/src/index.test.ts.

## REQ-GA-DOCS

**Actor/entry:** application developer or repository maintainer through harness guides, examples and canonical skill alignment. **Preconditions:** prior tickets accepted, current approved digest, existing locked dependencies. **Contracts:** CTR-GA-DOCS, CTR-GA-CLEANUP. **Data:** ephemeral definitions/configuration, existing runtime JSON, or public docs; no new persistence. **State:** authored → validated/compiled → built/executed/checked; validation failure produces no partial success. **Permissions:** application-selected registries and existing governance remain authoritative. **Side effects:** only those explicitly assigned in contracts; preflight has none beyond local policy reads. **Observability:** fixed safe errors and existing spec37 evidence; no policy/protected content. **Recovery:** correct declaration/config/artifact and rerun the same entrypoint. **Owner/final state:** ticket owner supplies passing public-interface evidence; independent reviewer accepts.

- **AC-GA-DOCS-SUCCESS:** Public guides teach inline TypeScript configuration, actual phase values, direct aliases, selectors and the same build preflight path.
- **AC-GA-DOCS-FAILURE:** No active native raw registration, inert metadata, file configuration, schema artifact, schema-compatibility promise, universal arrow rule or runtime type-safety claim remains.
- **AC-GA-DOCS-RECOVERY:** Canonical Harness skill and focused examples typecheck against current public exports; docs have no removed configuration leftovers.

Verification: ai-harness/examples/guardrails/src/index.test.ts, ai-harness/scripts/check-decision-boundaries.mjs.

## REQ-GA-WEBSITE

**Actor/entry:** application developer or repository maintainer through purista handbook, phase projections and skill reuse. **Preconditions:** prior tickets accepted, current approved digest, existing locked dependencies. **Contracts:** CTR-GA-DOCS, CTR-GA-CLEANUP. **Data:** ephemeral definitions/configuration, existing runtime JSON, or public docs; no new persistence. **State:** authored → validated/compiled → built/executed/checked; validation failure produces no partial success. **Permissions:** application-selected registries and existing governance remain authoritative. **Side effects:** only those explicitly assigned in contracts; preflight has none beyond local policy reads. **Observability:** fixed safe errors and existing spec37 evidence; no policy/protected content. **Recovery:** correct declaration/config/artifact and rerun the same entrypoint. **Owner/final state:** ticket owner supplies passing public-interface evidence; independent reviewer accepts.

- **AC-GA-WEBSITE-SUCCESS:** HTML architecture, diagram, Markdown projection, handbook and canonical PURISTA skills agree on final-only output, new authoring and preflight limits.
- **AC-GA-WEBSITE-FAILURE:** Focused audit detects stale phase/projection or removed API text; no blanket entity decoding or renderer change is introduced for the unreproduced report.
- **AC-GA-WEBSITE-RECOVERY:** Existing routes/layout/accessibility survive site build and link audit; rendered/copied factory snippet matches source; package skills regenerate through existing sync.

Verification: purista/scripts/knowledge-audit.mjs, purista/scripts/guardrails-knowledge.test.mjs, purista/scripts/skills-audit.mjs, purista/web/scripts/audit-internal-links.mjs.

## REQ-GA-CLEANUP

**Actor/entry:** application developer or repository maintainer through consumer cut, ci drift gates and final acceptance. **Preconditions:** prior tickets accepted, current approved digest, existing locked dependencies. **Contracts:** CTR-GA-CLEANUP, CTR-GA-GENERATION. **Data:** ephemeral definitions/configuration, existing runtime JSON, or public docs; no new persistence. **State:** authored → validated/compiled → built/executed/checked; validation failure produces no partial success. **Permissions:** application-selected registries and existing governance remain authoritative. **Side effects:** only those explicitly assigned in contracts; preflight has none beyond local policy reads. **Observability:** fixed safe errors and existing spec37 evidence; no policy/protected content. **Recovery:** correct declaration/config/artifact and rerun the same entrypoint. **Owner/final state:** ticket owner supplies passing public-interface evidence; independent reviewer accepts.

- **AC-GA-CLEANUP-SUCCESS:** Fresh package declarations, generated schema/export, real PURISTA consumers, both type suites and all hermetic regression gates pass without reduced thresholds.
- **AC-GA-CLEANUP-FAILURE:** Architecture/CI checks reject removed aliases/raw actions/duplicate shapes/stale generated schema and fail on incomplete consumer alignment.
- **AC-GA-CLEANUP-RECOVERY:** Example/starter/scaffolder zero-match scan is recorded; no Voyage access, migration/compatibility layer, source reset, unapproved install or publish occurs.

Verification: ai-harness/scripts/check-decision-boundaries.test.mjs, ai-harness/scripts/verify-decision-consumers.test.mjs.
