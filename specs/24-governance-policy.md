# Governance policy

**Status:** approved; callback/lifecycle/evidence authority updated 2026-08-26 by the decision-boundary scope.

**Purpose.** Defines the optional policy-driven governance layer for model-facing tool exposure and tool-call execution. Governance is not required for ordinary harness use. When configured, exposure rules can hide tools before a model step, and execution policies evaluate typed rules after agent permissions and tool allowlists, but before side-effecting tool execution.

## Goals

- Keep default DX unchanged: no `.governance(...)` call means no policy setup and no runtime cost beyond a single undefined check.
- Reuse the builder type system: native policy predicates receive the selected TypeScript tool's parsed Zod input.
- Support external ecosystems: OPA adapts through the optional first-party
  `@purista/harness-policy-opa` Data API package; Cedar, Eve-style controls,
  and product-specific rule stores adapt through application-owned
  `GovernancePolicyEvaluator` implementations.
- Preserve existing security layers: built-in permissions remain the coarse built-in-tool gate; governance is a business/domain policy gate.
- Emit observable policy, exposure, and approval events without persisting raw tool input.
- Keep policy evidence replayable by emitting stable decision ids, optional policy versions, and approval ids.

## Builder surface

`.governance(...)` is optional and may be called after `.agents(...)` or `.workflows(...)` and before `.build()`.

```ts
defineHarness()
  .models(...)
  .tools(...)
  .agents(...)
  .governance(({ native, rule, exposureRule, adapter }) => ({
    mode: 'enforce',
    defaultEffect: 'allow',
    exposure: {
      id: 'tenant-tool-exposure',
      rules: [
        exposureRule({
          id: 'hide-transfers-for-readonly-tenants',
          effect: 'hide',
          tools: ['transfer_funds'],
          when: ({ metadata }) => metadata.plan === 'readonly'
        })
      ]
    },
    approval: { request: async (req) => ({ decision: 'approved' }) },
    policies: [
      native({
        id: 'bank-transfer-policy',
        version: '2026-06-30',
        rules: [
          rule({
            id: 'large-transfer-approval',
            effect: 'require_approval',
            tools: ['transfer_funds'],
            when: ({ input }) => input.amount > 1_000
          })
        ]
      }),
      adapter({ id: 'external-engine', evaluate: async (ctx) => undefined })
    ]
  }))
  .build()
```

`rule(...)` narrows `ctx.input` from the selected tool id. For MCP and built-in tools, `ctx.input` is validated JSON-compatible input. For TypeScript tools, `ctx.input` is the parsed Zod input and validation failure occurs before policy evaluation.

`exposureRule(...)` narrows `ctx.toolId` from the selected tool id. Exposure rules do not receive tool input because no tool call exists yet; they are for per-agent, per-session, per-workflow, per-step, or metadata-driven capability shaping.

## Config

```ts
interface GovernanceConfig<S> {
  enabled?: boolean
  mode?: 'enforce' | 'shadow'
  defaultEffect?: 'allow' | 'deny'
  policies?: readonly GovernancePolicyDefinition<S>[]
  exposure?: GovernanceToolExposurePolicy<S>
  approval?: GovernanceApprovalProvider<S>
  audit?: GovernanceAuditSink
}
```

Defaults:

- `enabled`: `true` when `.governance(...)` is configured.
- `mode`: `'enforce'`.
- `defaultEffect`: `'deny'` when execution policies are configured and no policy returns a decision.

Shadow/disabled semantics, approval-only configuration, permission approval, strict callback contracts and defaults are defined in [approved decision-boundary contracts](./37-decision-boundaries/03-contracts/decisions.md). The execution policy default deny applies only when execution policies exist.

## Tool exposure

Exposure runs after `prepareStep.activeTools` filtering and before the model call. It can remove tools from the `tools` array sent to the provider:

```ts
interface GovernanceToolExposurePolicy<S> {
  id?: string
  version?: string
  defaultEffect?: 'expose' | 'hide'
  rules?: readonly GovernanceToolExposureRule<S>[]
}
```

Rules use `effect: 'hide' | 'expose'`, with `hide` winning when multiple rules match. In `mode: 'shadow'`, matching hide decisions emit `policy.exposure` but do not remove the tool.

The runtime rejects provider tool calls whose tool name was not exposed for the current step. This protects against provider bugs or stale model-side tool state.

## Effects and precedence

Supported effects:

| Effect | Behavior |
|---|---|
| `allow` | Records the policy decision and permits execution unless a stronger matching decision exists. |
| `audit` | Records/audits the policy decision and permits execution unless a stronger matching decision exists. |
| `require_approval` | Calls the configured approval provider before execution. Rejection blocks the tool. |
| `deny` | Blocks execution. |

When multiple policies match one call, precedence is locked:

`deny > require_approval > audit > allow`

## Execution, approval, evidence and validation

The [approved decision-boundary contracts](./37-decision-boundaries/03-contracts/decisions.md) are the single source for runtime ordering, correlated policy types, strict outcomes, combined permission/policy approval, cancellation, audit, safe events and identities. They replace the former callback/event contracts without compatibility aliases. `examples/bank-governance` is the immediate approval example; durable review is application-owned as specified by [review execution](./37-decision-boundaries/03-contracts/review-execution.md).

Keep duplicate policy/rule IDs, missing native rules, unknown tool references and non-function evaluator validation at build. Native predicates receive parsed effective inputs; exposure predicates have no tool input. External engines translate their own documents to the closed GovernanceDecision; Harness owns no external policy syntax, storage or bundle distribution. [Spec 41](./41-opa-policy-adapter.md) defines the optional typed OPA transport and preserves this boundary: applications still own identity, minimized request/result mapping, Rego/bundles, credentials, topology, and decision-log controls. Cedar and other policy engines continue to use application-owned evaluators.

## Example

The canonical minimal example is `examples/bank-governance`, which demonstrates:

- approval for transfers above a threshold;
- strict denial above a hard limit;
- strict denial when balance is lower than transfer amount;
- typed native rules over `transfer_funds` tool input.
