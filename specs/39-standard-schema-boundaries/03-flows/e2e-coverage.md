# End-to-end coverage

| Path | Trigger → processing → result | Verification |
| --- | --- | --- |
| PATH-SS-TYPES-SUCCESS | Register vendor schemas → builder retains schema generics → IDE/type fixtures expose exact nested input/output | equality and positive declaration fixtures for three vendors |
| PATH-SS-TYPES-FAILURE | Register invalid/model-incomplete/non-JSON schema or wrong invocation → compiler evaluates constraints → build fixture fails | negative `@ts-expect-error` fixtures, including two incompatible aliases |
| PATH-SS-TYPES-RECOVERY | Replace value with conforming schema/type → same chain rechecks → no cast/annotation required | recovered positive fixture |
| PATH-SS-VALIDATION-SUCCESS | Invoke agent/tool/workflow/guardrail → shared helper awaits schema → transformed JSON output reaches callback/result | table-driven sync/async/transform tests for every boundary |
| PATH-SS-VALIDATION-FAILURE | Schema returns issues, throws, rejects or outputs non-JSON → safe error mapper stops flow → no callback/provider/persistence effect | error snapshots plus fake call/storage counters |
| PATH-SS-VALIDATION-RECOVERY | Invoke same built Harness with valid data after failure → no failure state retained → run completes | failure-then-success test per runtime family |
| PATH-SS-PROJECTION-SUCCESS | Build with `ModelSchema` → input projection once, JSON check and freeze → cached schema serves all runs/retries | converter spy count, target assertion, recursive freeze and identity tests |
| PATH-SS-PROJECTION-FAILURE | Projection missing/throws/returns invalid value → build emits closed `HarnessConfigError` → no runnable Harness | three reason-specific tests and privacy snapshot |
| PATH-SS-PROJECTION-RECOVERY | Correct schema and rebuild → compilation is complete → runs consume new cached schema | failed-build then successful-build test |
| PATH-SS-PROVIDERS-SUCCESS | Core sends distinctive schema → adapter constructs SDK request → exact schema appears at request seam | OpenAI, Anthropic, Bedrock and Azure contract tests; no network |
| PATH-SS-PROVIDERS-FAILURE | SDK/provider rejects supported request shape → existing adapter mapper returns model error → no weakened retry | fake SDK rejection and captured request sequence |
| PATH-SS-PROVIDERS-RECOVERY | User supplies provider-compatible schema → same unchanged adapter path → response completes and local validation runs | second fake request plus core validation assertion |
| PATH-SS-CONSUMERS-SUCCESS | Reader follows guide/skill/site → copies vendor example → example compiles and behavior matches spec | snippet/example tests, docs build, skill/knowledge audits |
| PATH-SS-CONSUMERS-FAILURE | Stale Zod-only wording or invalid link/snippet enters a canonical surface → audits/build detect mismatch → release gate fails | terminology `rg`, link/docs build, skill sync/audits |
| PATH-SS-CONSUMERS-RECOVERY | Canonical source is corrected and mirrors regenerated → audits rerun → all consumers align | clean regeneration diff and passing gates |
| PATH-SS-CLEANUP-SUCCESS | Final source scan and full CI run → canonical paths only → breaking release is publishable | exact forbidden-pattern scans and repo CI |
| PATH-SS-CLEANUP-FAILURE | Legacy, placeholder, skipped test, widening or unrelated deletion detected → final gate stops → no completion claim | clean-tree scoped diff, scans and test enumeration |
| PATH-SS-CLEANUP-RECOVERY | Remove offending code/test and rerun all gates → canonical implementation remains → acceptance passes | evidence captures commands and outputs |

## Boundary matrix

| Runtime family | Input validation | Output validation | Model projection |
| --- | --- | --- | --- |
| default-loop agent | before instructions/hooks/model call | every structured model candidate before completion | output schema at build |
| custom-handler agent | before handler | handler return before completion | none |
| TypeScript tool | model arguments before authorization/handler | handler return before model payload/persistence | input schema at build |
| workflow | before handler/child task | handler return before completion | none |
| guardrail value | selected value before callback | callback contract unchanged | none |
| memory summarization object request | existing candidate flow | parsed summary before use | explicit existing JSON Schema, never a validator cast |

Cancellation, telemetry and logging follow existing run lifecycle. Async validation introduces no detached promises. Recovery means a new invocation/build with corrected input/schema, never silent coercion or provider keyword removal.
