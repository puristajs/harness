# Stack

- Runtime: Node.js `>=24.15`, ESM, strict TypeScript.
- Canonical interfaces: `@standard-schema/spec` `StandardSchemaV1` and `StandardJSONSchemaV1`, direct runtime-free dependency of `@purista/harness`.
- Default/internal validator: existing Zod 4 dependency.
- Cross-vendor dev fixtures: ArkType `^2.1.28`, Valibot `^1.2.0`, and `@valibot/to-json-schema` `^1.5.0`; test/dev only.
- JSON contract: existing `JsonValue` and `isJsonValue` from `packages/harness/src/models/json.ts`.
- Tests: Vitest runtime/contract suites plus TypeScript declaration/type fixtures.

No adapter package gains a validator dependency. No new compiler, code generator, service, store, or network dependency is introduced.
