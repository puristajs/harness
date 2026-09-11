# Consumer and clean-cut contracts

## CTR-SS-CONSUMERS

The same release updates:

- Harness overview/architecture/config/tool/agent/workflow/public API/error/testing specs.
- Harness README, guides, API examples, all examples that expose public schemas, and the canonical `skills/ai-harness` package plus its generated mirror verification.
- PURISTA website/handbook Harness pages and navigation/search metadata where text changes.
- Canonical `purista/skills` content that describes Harness or schema support. General PURISTA framework guidance keeps its existing Standard Schema semantics.
- Package changelog/release note stating the breaking public schema contract and the supported model-facing requirement. This is a concise current-state release note, not a migration guide.

Public documentation says “Zod is the default and examples use it; any Standard Schema validator works. Model-facing tool input and default-loop output additionally require Standard JSON Schema support.” It includes runnable Zod, ArkType, and Valibot snippets and labels the Valibot projection wrapper dependency.

## CTR-SS-CLEANUP

Acceptance source audits over public boundary files must find no:

- `z.ZodTypeAny`, `z.input`, or `z.output` in public agent/tool/workflow/guardrail definition generics;
- direct `.parse`, `.safeParse`, or `z.toJSONSchema` for user-supplied value schemas;
- casts from validator objects to `JsonValue` or provider schema types;
- deprecated aliases, legacy overloads, compatibility adapters, dual validation paths, schema-vendor switches, unfinished stubs, skipped conformance tests, or placeholder examples.

Internal Zod schemas for configuration, persisted records, built-in tools, decisions, sandboxing, and errors are explicitly retained unless touched code can be simpler without them. A repository-wide Zod purge is prohibited because it increases scope and complexity without improving the public contract.

Voyage remains untouched. Existing unrelated working-tree changes must be preserved.
