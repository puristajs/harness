# Non-functional requirements

## Type and API quality

- No known schema flowing through a public builder/result widens to `unknown`/`JsonValue`; private existential constraints may use `any` only where Standard Schema generic variance requires it.
- Equality-based type fixtures cover caller input, validated callback input, handler return input, validated result, nested aliases, transforms, defaults/optionals, arrays, and negative cross-alias use for Zod, ArkType, and Valibot.
- All new exports include TypeDoc-ready TSDoc and non-obvious examples.

## Performance and capacity

- Model projection count is exactly one per registered tool input/default-loop output per successful `build()`.
- Runtime validation count is exactly one per boundary crossing; no duplicate vendor parse follows it.
- Issue serialization work and output are bounded to 100 issues. Generated schemas are cloned/frozen once, then reused by reference.
- Existing run/tool/session budget, timeout, and concurrency limits are unchanged.

## Resilience and async behavior

- Sync/async validation shares one awaited path; no floating promises or unhandled rejections.
- Existing cancellation signals are checked before and after awaited validation.
- Build is atomic: projection failure returns no partially runnable Harness.
- Failed invocation state is not cached; a later valid invocation can succeed.

## Security and privacy

- Never emit candidate values, issue messages/paths, generated schema bodies, validator exception messages, or private causes in serialized errors, logs, spans, events, or persistence.
- Use `isJsonValue`; do not probe with `JSON.stringify`, which could invoke user code or leak content.
- Schema converters run as application-supplied code during explicit build, not at import time or in provider adapters.
- No credentials, live calls, telemetry exporters, or network access are required for acceptance.

## Supply chain

- `@standard-schema/spec` is a direct dependency of `@purista/harness` and type-only at runtime call sites.
- ArkType, Valibot, and `@valibot/to-json-schema` are dev-only fixtures; provider packages do not depend on them or Zod.
- Lockfile changes are scoped and normal repository license/audit checks pass. No postinstall scripts or dynamic dependency loading is added.

## Accessibility and localization

No interactive UI is added. Documentation keeps existing semantic headings/code labels and English locale conventions; existing site accessibility/build checks remain the gate.
