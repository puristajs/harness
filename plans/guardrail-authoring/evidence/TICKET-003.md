# TICKET-003 — Provider-neutral interceptor build preflight

Recorded implementation: 2026-08-26. Status: **implemented; not accepted**.
Independent review controls acceptance and lifecycle promotion.

## Scope and contract trace

Implemented `CTR-GA-BINDING`, `CTR-GA-ERRORS`, and
`REQ-GA-REQUIREMENTS` within the ticket write scope.

- Added the strict core `agentExecutionRequirementsSchema` and its derived
  public `AgentExecutionRequirements` type. It requires nonempty unique tool
  ids, aliases, and capabilities whenever those lists are declared, and shares
  the closed `ModelCapability` vocabulary.
- Added optional `requirements` to `AgentExecutionInterceptor` with TSDoc.
  The field remains provider-neutral and does not import guardrails code.
- Added deterministic, interceptor-order requirement compilation. Tool ids are
  deduplicated; per-alias model capabilities are unioned and cannot weaken
  earlier interceptor requirements. Each compiled entry retains the exact
  declaring interceptor path, so every missing/disabled tool and
  missing/capability model error returns
  `agents.<id>.interceptors.<index>.requirements` with its offending id.
- Extended the existing `.build()` agent reference validation. It parses every
  manually authored requirement declaration, requires its tools to be both
  registered and enabled for that agent, then requires each model alias and
  capability to exist in the completed model registry.
- Extracted the canonical built-in resolution used by both build validation and
  the default agent loop; disabled built-ins cannot be restored by a
  requirement. The runtime loop now uses `BUILTIN_TOOL_NAMES` through that
  resolver instead of a duplicate list.
- Reused `hasModelCapabilities` from the model registry for preflight and
  runtime capability membership. The build path only examines configuration;
  it opens no session, starts no MCP process, invokes no provider, and performs
  no sandbox action.
- Added direct, callback-helper, and static-module tool-registration coverage,
  including MCP alias validation and model registration after `.agents()`.
  Negative coverage checks malformed, duplicate, missing, disabled, and
  insufficient declarations while asserting zero provider requests.

No YAML/configuration-file surface was restored and no Voyage code was read or
changed. The pre-existing dirty worktree was preserved.

## Acceptance mapping

| Acceptance ID | Evidence |
| --- | --- |
| `AC-GA-REQUIREMENTS-SUCCESS` | `build-validation.test.ts` builds requirements against direct helper, static-module, MCP-alias, configured-model, and default-builtin registrations; `harness-typing.ts` checks the public type and closed capability vocabulary. |
| `AC-GA-REQUIREMENTS-FAILURE` | `build-validation.test.ts` rejects malformed/duplicate requirements, missing or disabled tools, missing aliases, and unavailable capabilities before any provider request, with an exact indexed declaration path and offending id. |
| `AC-GA-REQUIREMENTS-RECOVERY` | The successful fixture declares its model after `.agents()` and uses the same canonical default-builtin resolver as the runtime loop; existing `prepareStep` narrowing tests retain the rule that unknown active tools are rejected. |

## Verification

- Scoped spec checker: passed.
- Scoped plan checker: passed.
- Focused requirement/interceptor/public API tests: passed, 82 tests.
- `npm --prefix ai-harness run test:types --workspace @purista/harness`: passed.
- `npm --prefix ai-harness test --workspace @purista/harness`: passed outside
  the restricted sandbox, 57 files / 932 tests. The restricted run cannot bind
  the local HTTP-MCP fixture (`listen EPERM 127.0.0.1`), which is environmental.
- `npm --prefix ai-harness run build`: the Harness package and all addon
  packages compiled successfully outside the restricted sandbox. The aggregate
  command ended nonzero only on the separate guardrails example reason-code
  mismatch at `examples/guardrails/src/index.ts:34`; that file is outside this
  ticket's scope and needs consumer cleanup before the final aggregate gate.
- `git -C ai-harness diff --check`: passed.

## Review focus

Verify the build path stays declarative and that requirements never widen
permissions or model/tool availability. Also verify the later attachment ticket
derives requirements only from active non-retrieval actions and continues to
use this core validator.
