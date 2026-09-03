# Stack and research

Use the checkout's locked Node/npm/TypeScript/Zod/Vitest toolchain; no new
runtime or dev dependency. Inspected on 2026-08-26: addon declares Zod ^4.4.3;
engines Node >=24.15.0. Remove the unneeded `yaml` dependency and its lockfile
entry. Keep remaining lockfile versions; upgrades are not necessary for the
chosen APIs and belong to separate work. The installed TypeScript
compiler/prototype results are evidence of feasibility, not proof that all
future changes compile.

Current primary documentation and dated research evidence checked 2026-08-26:

- [TypeScript contextual typing](https://www.typescriptlang.org/docs/handbook/type-inference): function expressions gain argument context from their expected function type.
- [TypeScript satisfies](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html): validation can preserve an expression's more precise inferred type.
- [Zod schemas](https://zod.dev): schema input/output types keep the inline public configuration and runtime validation aligned.

No external service, container, DB, credentials, provider API request or new
generator dependency is required. Existing compiled declaration outputs and
package scripts remain the build system.
