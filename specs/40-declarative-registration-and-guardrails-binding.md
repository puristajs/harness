# Declarative registration and Guardrails binding

**Status:** authoring and registration are superseded by
[42-composable-definitions-and-catalogs](./42-composable-definitions-and-catalogs.md)
for the v4 clean break.

Agents and workflows use `defineAgent(...)` and `defineWorkflow(...)`, and an
immutable Harness uses `.addAgent(...)`, `.addWorkflow(...)`, or `.use(catalog)`.
The former inline registry and builder APIs are removed.

The surviving Guardrails rule is simple: an agent may receive a provider-neutral
`guardrails` binding created by `defineGuardrails(...)`. Harness compiles its
requirements and applies it to the standard model loop. Registration performs
no provider call and grants no model, tool, Skill, sandbox, or permission
authority. `Guardrails.attach(...)` does not exist.

Detailed phase, failure, privacy, requirement, and testing behavior remains in
[30-guardrails](./30-guardrails.md),
[37-decision-boundaries](./37-decision-boundaries/00-vision.md), and
[38-guardrail-authoring](./38-guardrail-authoring/00-vision.md).
