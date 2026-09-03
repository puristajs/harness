# Standard Schema boundaries

Status: approved clean-break specification (2026-08-28).

## Goal

`@purista/harness` accepts any validator implementing Standard Schema V1 at public validation boundaries, preserves exact nested input/output inference, and requires Standard JSON Schema V1 only where a model provider needs JSON Schema. Zod remains the default documentation choice and an internal implementation dependency where it is simpler; it is no longer the public schema contract.

## Decisions

- **DEC-SS-PUBLIC:** Export PURISTA-style `Schema`, `ModelSchema`, `Infer`, and `InferIn` types from `@purista/harness`. Public agent, tool, workflow, and guardrail schema generics must not mention Zod.
- **DEC-SS-JSON:** Only a schema's validated output (`Infer<S>`) at a Harness boundary extends `JsonValue`; raw `InferIn<S>` remains vendor-exact so defaults, optionals, coercion and transforms work. Raw values never reach persistence or providers. Non-JSON validated outputs are rejected by TypeScript when visible and by one runtime JSON assertion before any handler, persistence or provider use.
- **DEC-SS-MODEL:** Tool input and default-loop agent output use `ModelSchema`; agent input, custom-handler agent output, tool output, workflow input/output, and guardrail values use `Schema`.
- **DEC-SS-PROJECTION:** Convert model-facing schemas with `~standard.jsonSchema.input({ target: 'draft-2020-12' })` during `build()`, validate the result as `JsonValue`, deep-freeze it, and cache it. Never convert in a run or loop.
- **DEC-SS-VALIDATION:** One async helper invokes `~standard.validate`; returned issues produce `ValidationError`, validator throws/rejections produce `InternalError`, and successful transformed output is the value used downstream.
- **DEC-SS-PROVIDERS:** Provider ports continue accepting plain `JsonValue` JSON Schema. Adapters pass schemas through without Zod imports, conversion, keyword stripping, or rewriting.
- **DEC-SS-CLEAN:** This is a breaking replacement. Remove superseded Zod public constraints, parsing branches, casts, adapters, overloads, and compatibility code. No migration layer or deprecated alias is allowed.
- **DEC-SS-CONSUMERS:** Update Harness specs/docs/examples/skill, the PURISTA website and canonical PURISTA skills in the same release. Voyage is out of scope.

## Scope

In scope: `@purista/harness`, `@purista/harness-guardrails` public value-schema surface, all first-party model adapters, examples/type tests, Harness documentation and skill, PURISTA website/handbook and canonical skills, package metadata, and release notes.

Out of scope: replacing Zod in internal configuration/state/error schemas, adding provider-specific schema normalizers, live provider calls, new provider capabilities, migration helpers, and Voyage.

## Success

Zod, ArkType, and Valibot examples compile with exact nested types; runtime conformance covers synchronous/asynchronous success, issues, throws, transforms, and non-JSON outputs; model schemas compile once; every adapter receives the exact frozen JSON Schema produced at build; legacy public Zod coupling is absent by source audit.
