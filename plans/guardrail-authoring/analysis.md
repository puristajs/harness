# Read-only analysis and decisions — 2026-08-26

Baseline: ai-harness c378607de9e7f19e3e985b8f8dbd84457ae5592a plus the existing dirty worktree, including the completed decision-boundaries work. Voyage excluded. No implementation edits, installs, builds or provider calls were performed by this planning phase. Independent source/type probes were in memory; a source-file hash snapshot protects pre-existing changes.

| Finding | Evidence at inspected baseline | Impact / effort / risk / confidence | Decision |
| --- | --- | --- | --- |
| YAML is optional but poorly presented | config.ts79 accepts objects; examples/guardrails/src/index.ts32 uses them | DX / S / low / high | TS-first guide, optional deploy artifact |
| Metadata preservation is intentional but confusing | spec30:53; config.ts42; actual NeMo uses these fields operationally | maintenance / M / medium breaking / high | Remove metadata and NeMo names deliberately |
| Config fields and normalized types are handwritten twice | config.ts8–49,79–168; unknown entry erases literals | DX/maintenance / M / medium / high | One Zod source; inline typed or explicit dynamic parse |
| Default/inline action typing admits invalid transforms | rails.ts119–128; existing negatives use explicit false generic | request-time failure / M / medium / high | Opaque tokens with strict contextual construction |
| Narrow evaluators rely on method bivariance | rails.ts103,119; isolated unsafe extracted callback compiled | unsound public type / M / medium / high | Function property plus typed private thunk |
| Narrow tool actions run against unrelated tools | rails.ts207–224; parseProtectedValue before callback | availability / M / medium / high | Select exact tool IDs before parsing |
| Model dependencies discovered during requests | rails.ts296–305; build already validates agent refs at defineHarness.ts1818 | late deployment failure / M / low-medium / high | Pure interceptor requirements through build |
| Sensitive codec narrowing lacks schema construction fence | sensitive-data.ts70–88,184–198 | unsafe callback expectation / M / medium / high | Singular schema-bound tool action factory |
| Native tool input is any | defineHarness.ts323,421,1317 | wrong code compiles / M / medium breaking / high | Existing builder-local helper pattern, nominal accepted definitions |
| Handler return and invocation input use wrong schema side | defineHarness.ts333,480–498,1045; runtime parses after return | transformed schemas unusable / M / medium / high | z.input at ingress/handler return, z.output after parse |
| Resolved definitions copy public definitions | defineHarness.ts1065,1102 | drift / S / low / high | Canonical aliases |
| Website still claims output rails inspect every model result | GuardrailsArchitecture.astro32–34; pages/harness/guardrails.astro45 versus rails.ts211 | incorrect coverage expectation / S / low / high | Shared phase prose and focused audit |

Probes confirmed: string rail attached to object agent builds then fails invalid_result before provider; tool mismatch builds then fails invalid_result after one provider call and zero handlers; missing model check alias builds then callback_failed before provider. These are fail-closed availability/diagnostic gaps, not bypasses of core allowlists.

Native helper + private symbol prototype, mixed MCP, files-only negative exec, wrong output/property, raw object rejection and captured reuse compiled with zero fixture diagnostics. A larger source-overlay comparison introduced no new diagnostics, but the JS compiler API had six unchanged baseline diagnostics; it is not reported as a clean existing suite. Raw schema-map helper alternatives lost contextual typing and were rejected.

The literal &#x20; issue was not reproduced in source, generated Markdown, decoded HTML or code-copy textContent. No speculative decoder change is approved. No blanket arrow-function conversion or new broad factory aliases: contextual typing helps callbacks, but explicit dependency parameters and inferred factory return types remain appropriate.

Schema compatibility has a hard boundary: Zod refinements/coercions/defaults are arbitrary code and phase values have different parse timing. The proposal validates known bindings upfront and retains runtime schema fences; it makes no universal attach-compatibility claim. See the canonical stage table, not an inferred promise from method names.

Current primary references and rejected alternatives are in specs/38-guardrail-authoring/00-stack.md and 00-vision.md. Their decisions are normative; this audit is evidence only.
