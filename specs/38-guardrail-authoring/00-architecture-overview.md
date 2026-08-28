# Architecture

```mermaid
flowchart LR
  TS[Typed inline object and action helpers] --> Compile[defineGuardrails]
  Schema[Canonical Zod config] --> Compile
  Compile --> Attach[Interceptor with declared requirements]
  Attach --> Build[Existing Harness build validation]
  Build --> Run[Existing bounded decision runtime]
```

Core owns registry validation, native tool definition inference and
provider-neutral interceptor requirements. The addon owns the canonical Zod
configuration, actions/selectors and maps active actions into those
requirements. Applications own providers, detectors, schemas, named actions and
build-before-serving. Website and skills consume the public behavior; they do
not own alternative contracts. No dependency points from core into the addon.

There are deliberately separate static, construction and invocation guarantees.
They reuse the same runtime compiler/validator and do not claim to prove
semantic inclusion between arbitrary Zod schemas. See the normative stage table
and actual phase values in the contracts.
