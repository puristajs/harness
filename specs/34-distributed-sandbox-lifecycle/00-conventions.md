# Conventions

- Public names follow existing port style: `SandboxScope`, `SandboxOpenMode`,
  `SandboxOpenOptions`, `SandboxOpenResult`, `SandboxTerminateOptions`, and
  `SandboxStateLostError`.
- Scope string fields are non-empty after trim and bounded by the existing
  session, run, Harness-name, and identity validators. No second identifier
  validation system is introduced.
- Session lifetime forbids `runId`; run lifetime requires it. `role` is
  `primary` or `child_task`.
- Exact optional identity is semantic: omitted, tenant-only, principal-only,
  and tenant-plus-principal scopes are distinct. Core does not synthesize
  placeholder identity values.
- Adapter-private generation numbers and fencing tokens are positive safe
  integers. They are not public request fields or telemetry attributes.
- Provider references are opaque, bounded, non-secret adapter state. They are
  not signed URLs, credentials, host paths, public return values, or telemetry
  correlations.
- `mode: 'create'` is restricted to a newly allocated logical scope;
  `mode: 'attach'` is the normal path for a persisted scope and never creates;
  `mode: 'restore'` requires successful committed-workspace resume and binding.
- Existing `snapshot`, `resume`, and `hibernate` names retain their current
  meanings. This feature does not add synonymous pause methods.
- Sandbox topology is absent from the runtime contract. Adapter packages prove
  distributed behavior in conformance tests; Harness and PURISTA never select
  a topology-specific method or branch.
- Concise single source of truth: the machine-readable contract and generation
  map own new shapes and destinations; prose links instead of duplicating field
  definitions.
- Strong boundary type policy: public boundaries are closed types, never
  `Record<string, unknown>` or open maps.
- Generation map source-contract ownership is recorded in
  `03-contracts/generation-map.yaml` and checked for drift.
- Dated research evidence records current primary documentation and SDK/API
  versions during the provider bake-off. Dependency lockfiles, licenses,
  vulnerability checks, and provenance remain release supply-chain gates.
