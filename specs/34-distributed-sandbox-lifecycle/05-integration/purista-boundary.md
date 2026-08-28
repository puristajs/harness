# PURISTA integration boundary

## Dependency direction

`@purista/harness` is the standalone library and public contract owner.
`@purista/core` may use Harness under the hood. The allowed direction is:

```text
PURISTA Core -> public @purista/harness <- provider/workspace addons
```

Harness core and addons never import PURISTA Core. Provider adapters never
receive PURISTA `EBMessage`, service-builder, command, subscription, or event
types. This keeps every Harness adapter usable in a non-PURISTA application.

## Mapping owned by PURISTA

- PURISTA maps authenticated message `tenantId` and `principalId` into the
  existing `HarnessIdentity` before `getSession`.
- PURISTA application policy decides whether tenant and principal are required;
  Harness does not synthesize either value or embed a PURISTA-specific rule.
- PURISTA maps service/workflow execution to the existing Harness session and
  run APIs. It does not call provider SDKs or adapter-private lifecycle APIs.
- PURISTA does not inspect sandbox topology or branch on local versus
  distributed operation. The composition root selects a deployment-appropriate
  adapter; production adapter release tests own multi-client safety. Startup
  validates only behavior that changes application semantics, such as
  `sandbox.live_process_preservation` and durable-workspace capabilities, using
  existing capability requirements.
- `SandboxStateLostError` is projected through the existing PURISTA error
  mapping without leaking scope or provider details.
- Harness owns standard sandbox telemetry. PURISTA may add its normal service/
  command parent context but does not emit duplicate lifecycle spans/metrics.

## Composition and DX

PURISTA keeps the existing `ai.sandbox` and `ai.workspace` composition
boundaries. A provider package may offer a convenience factory that returns
compatible `{ sandbox, workspace }` ports backed by shared private state, but
PURISTA registers the two public interfaces independently. No provider-specific
configuration or lifecycle type enters a service definition.

`createAgentTestHarness(definition, { models, sandbox })` accepts the same public
Sandbox port and applies the production per-agent policy selector. Tests cover
scoped create/attach, identity, release, override, and disabled selection; the
helper does not introduce a separate lifecycle or adapter abstraction.

The Harness contract and its standalone tests must pass before PURISTA runtime
projection begins. PURISTA integration tests then verify identity mapping,
behavioral-capability startup failure, absence of topology branching, ordinary
state loss, durable recovery, release, termination, and telemetry ownership.
