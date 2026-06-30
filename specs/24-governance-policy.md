# Governance policy

**Purpose.** Defines the optional policy-driven governance layer for model-facing tool exposure and tool-call execution. Governance is not required for ordinary harness use. When configured, exposure rules can hide tools before a model step, and execution policies evaluate typed rules after agent permissions and tool allowlists, but before side-effecting tool execution.

## Goals

- Keep default DX unchanged: no `.governance(...)` call means no policy setup and no runtime cost beyond a single undefined check.
- Reuse the builder type system: native policy predicates receive the selected TypeScript tool's parsed Zod input.
- Support external ecosystems: policy engines such as OPA, Cedar, Eve-style controls, or product-specific rule stores adapt through `GovernancePolicyEvaluator`.
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
    approval: { request: async (req) => ({ decision: 'approved', approverId: 'ops' }) },
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

`rule(...)` narrows `ctx.input` from the selected tool id. For MCP and built-in tools, `ctx.input` is JSON-compatible raw input. For TypeScript tools, `ctx.input` is the parsed Zod input and validation failure occurs before policy evaluation.

`exposureRule(...)` narrows `ctx.toolId` from the selected tool id. Exposure rules do not receive tool input because no tool call exists yet; they are for per-agent, per-session, per-workflow, per-step, or metadata-driven capability shaping.

## Config

```ts
interface GovernanceConfig<S> {
  enabled?: boolean
  mode?: 'enforce' | 'shadow'
  defaultEffect?: 'allow' | 'deny'
  policies?: readonly GovernancePolicyDefinition<S>[]
  exposure?: GovernanceToolExposurePolicy<S>
  approval?: GovernanceApprovalProvider
  audit?: GovernanceAuditSink
}
```

Defaults:

- `enabled`: `true` when `.governance(...)` is configured.
- `mode`: `'enforce'`.
- `defaultEffect`: `'deny'` when execution policies are configured and no policy returns a decision.

`mode: 'shadow'` evaluates and emits decisions but never hides tools, blocks calls, or requests approval. Use it for rollout, drift checks, and migration from another policy ecosystem.

At least one of `policies` or `exposure.rules` must be present when governance is enabled. A config with only exposure rules does not apply execution `defaultEffect` to later tool calls.

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

## Runtime order

For every model tool call:

1. Canonicalize built-in aliases.
2. Check per-agent built-in permissions.
3. Check agent custom-tool allowlists and registry presence.
4. Validate TypeScript tool input with the configured Zod schema.
5. Evaluate governance when configured.
6. Emit policy and approval events.
7. Emit `tool.started`.
8. Execute the tool.
9. Validate TypeScript tool output.
10. Emit `tool.finished`.

Policy denial and rejected approval are recoverable default-loop tool errors. The model receives a serialized tool result with `code: 'POLICY_DENIED'` and the loop may continue.

## External policy adapters

```ts
interface GovernancePolicyEvaluator<S> {
  id: string
  version?: string
  evaluate(ctx: GovernanceContext<S>): GovernanceDecision | readonly GovernanceDecision[] | undefined | Promise<...>
}
```

Adapters translate harness context into the external policy engine's input document and translate engine output back into `GovernanceDecision`. The harness does not own OPA/Cedar/Eve syntax, storage, deployment, or bundle distribution. Those belong in application code or adapter packages.

## Approval

Approval is configured only when policies use `require_approval`:

```ts
interface GovernanceApprovalProvider {
  request(request: GovernanceApprovalRequest): Promise<GovernanceApprovalResult>
}
```

Approval requests include a stable `approvalId`, `callId`, and all matching `require_approval` decisions. Approval runs under the tool timeout and cancellation signal. If approval is required but no provider is configured, the tool is denied with `reason: 'approval_unavailable'`.

## Events and privacy

Governance emits:

- `policy.evaluated`
- `policy.exposure`
- `approval.requested`
- `approval.finished`

Persisted payloads include ids, `decisionId`, optional `policyVersion`, rule id, effect, enforcement mode, approval id, decision, approver id, reason, risk level, and tags. They do not include raw tool input or tool output.

## Validation

`build()` rejects:

- governance config without execution policies or exposure rules;
- duplicate policy ids;
- native policies without rules;
- duplicate native rule ids within one policy;
- native rules referencing unknown tool ids;
- duplicate exposure rule ids;
- exposure rules referencing unknown tool ids;
- adapter policies without an `evaluate` function.

## Example

The canonical minimal example is `examples/bank-governance`, which demonstrates:

- approval for transfers above a threshold;
- strict denial above a hard limit;
- strict denial when balance is lower than transfer amount;
- typed native rules over `transfer_funds` tool input.
