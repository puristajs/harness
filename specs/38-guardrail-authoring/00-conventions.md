# Conventions

## CONV-GA-STYLE

Follow `ai-harness/AGENTS.md`, `.agent/IMPLEMENTATION.md` and canonical PURISTA guidance. Strict TypeScript, named lowerCamelCase schema values, exported PascalCase types, provider-neutral public ports, Zod-derived non-generic types, generic projections for genuinely generic relationships, TSDoc with useful examples, and explicit ownership are mandatory. No `any`, `Function`, bivariant-method loophole, unchecked JSON-to-domain cast or duplicate field interface is allowed in new/changed authoring boundaries. External unknown data is validated at ingress; open JsonValue leaves stay explicit.

The sole existing-erasure exception is the heterogeneous native runtime ToolDefinition projection reused as registered storage behind generic construction plus CheckedTools validation, as specified in CTR-GA-CALLBACKS. It cannot be used as callback contextual type or expanded into new any-based aliases. Opaque guardrail tokens need no such callback erasure.

Extend existing modules/tests before introducing files. New files are limited to cohesive config/action/requirements topics listed in file structure. Use public core exports in addons; no provider SDK or private core imports. Reuse canonical decision schemas/executor/evidence, builtin IDs, model capability vocabulary and tool preparation. Never add another timer/approval/validation engine.

## CONV-GA-EXECUTION

Implement tickets in dependency order. A contract mismatch is a blocker to record, not permission to invent another design. Implementation agents may choose private naming/extraction consistent with these conventions; public behavior, fields, APIs, defaults, compatibility, validation stages and verification cannot be changed without a newly approved digest. Preserve dirty unrelated work. Never install, publish, fetch model assets, access production secrets or reset data as an implicit test step.
