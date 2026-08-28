# File and module placement

| Owner | Existing / approved new location | Responsibility |
| --- | --- | --- |
| Core authoring | `packages/harness/src/harness/defineHarness.ts` | Canonical definitions, helper overloads, input/output aliases |
| Core requirements | new `packages/harness/src/harness/agent-requirements.ts` | Requirement Zod schema, internal build validator and tool-name resolution; exported through root |
| Core tool registration | new `packages/harness/src/harness/tool-definition.ts` | Private registration symbol/helper/guard; canonical types stay with existing definitions |
| Core model validation | `packages/harness/src/models/registry.ts` | Shared capability predicate, no addon coupling |
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
subtrees that must change because a removed API no longer compiles.
