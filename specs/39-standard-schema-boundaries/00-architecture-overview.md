# Architecture overview

```text
user validator
  ├─ Standard Schema V1 ──> async validate ──> validated JsonValue ──> handler/persistence
  └─ Standard JSON Schema V1 (model boundaries only)
          └─ build-time input projection ──> frozen JsonValue schema ──> provider port ──> adapter
```

The core owns schema typing, validation, JSON assertions, projection, caching, and safe error mapping. Builders preserve the schema objects as type parameters and create private runtime definitions at `build()`. Sessions, agents, workflows, tools, and guardrails consume those definitions; they do not inspect validator vendors.

Model adapters remain downstream of a plain JSON Schema port. This isolates provider SDK limitations: provider incompatibility is reported by the adapter/provider call and is never hidden by lossy core rewriting. Local Standard Schema validation remains authoritative for all model outputs and tool arguments.

The two standards are deliberately separate. `Schema` means “can validate”; `ModelSchema` means “can validate and project both typed directions to JSON Schema.” Requiring `ModelSchema` only at model-facing boundaries is the smallest sound contract.
