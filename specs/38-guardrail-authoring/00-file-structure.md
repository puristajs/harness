# File and module placement

| Owner | Existing / approved new location | Responsibility |
| --- | --- | --- |
| Core authoring | `packages/harness/src/definitions/` and `packages/harness/src/harness/` | Canonical factories, immutable composition, input/output aliases |
| Core requirements | `packages/harness/src/harness/runtime-requirements.ts` | Requirement schema, private graph compiler and tool-name resolution; exported requirement view through root |
| Core tool definitions | `packages/harness/src/definitions/tool.ts` | Portable definition factory and private runtime projection |
| Core model validation | existing model runtime owner | Shared capability predicate and private binding index, no addon coupling |
| Addon config | `src/config-schema.ts`, `src/config.ts` | Canonical schema/derived types and inline normalization/compilation |
| Addon actions | new `src/action.ts`, existing `src/rails.ts` | Generic constructor/private token adapter versus coordinator/compile/attach |
| Addon sensitive actions | existing `src/sensitive-data.ts` | Shared detector algorithms and fixed/singular factories |
| Verification | Existing core/addon type-tests and test files; example guardrails | Extend natural suites, no parallel test framework |
| Website | `purista/web/src/data/guardrails-content.ts` | Shared phase/guarantee prose for existing page/diagram/Markdown projection |

Core addon package roots in this table are relative to ai-harness.
Provider/detector implementation internals are not refactored. New runtime files
stay TypeScript. No generic shared utility package, contracts package, site
renderer, file configuration, generated config output, or configuration
generator. Ticket scopes name exact consumer files or the bounded example/docs
subtrees that must change to follow the v4 definition contract.
