# Guardrail authoring and Harness callback inference

**Status:** approved target specification under the repository owner's delegated
approval in task `01a03d51-6262-7480-89eb-baa163905ef6`, 2026-08-26. The
scoped readiness report binds approval to the final manifest. This is
definition readiness, not implementation acceptance.

## Authority

This workstream supersedes spec30 configuration/authoring and spec31 sensitive
tool authoring, plus the corresponding spec37 rail type declarations. Spec37
continues to own decisions, phase/effect order, approval, cancellation, privacy
and durable semantics. It overrides specs07/09/10/13 only for callback schema
directions and native tool helper registration. No approval-policy redesign or
durable-data change is included.

The user requested analysis, an executable implementation plan, updated
automatically approved specs, breaking changes when useful, reuse and cleanup
without legacy/compatibility/migration layers. The user approved this clean
break: inline TypeScript configuration is the only authoring surface. Voyage is
explicitly excluded.

## Decisions

| ID | Approved decision | Rejected alternative / reason |
| --- | --- | --- |
| DEC-GA-CONFIG | Strict inline TypeScript configuration derived from one Zod schema; remove the complete file configuration surface | A second format duplicates the public configuration model and its validation, deployment, documentation and maintenance burden |
| DEC-GA-PREFLIGHT | Reuse compile/build stages in application composition | A second public verifier/CLI duplicates the production validation path |
| DEC-GA-TOKENS | One typed action constructor and opaque phase token | Bivariant evaluator methods or erased `any` registries hide mismatches |
| DEC-GA-BINDING | Declare tool/model dependencies, validate through core build; select tools before value parsing | Registry-aware addon builder, schema equality, and automatic permission expansion add complexity or false guarantees |
| DEC-GA-CALLBACKS | Builder-local native tool helper, canonical function-property contracts, schema input/output direction | Blanket arrow conversion or broad factory annotations do not fix inference and can erase return precision |
| DEC-GA-GENERATION | Zod-derived TypeScript only through declaration emit | Committed schema/reference outputs and generator scripts create stale copies of the inline API |
| DEC-GA-CLEAN | Direct removal and in-repo consumer alignment | No compatibility mode, dual API, migration layer or data reset |

## Outcomes

Developers author a small, checked configuration next to their actions, see
action/phase errors during typechecking, reject registry mistakes before
requests, and understand which runtime validation is still necessary.
Maintainers own one shape per concept, one decision lifecycle, one registry
validator and one phase-content source per website projection.

Universal Zod compatibility, arbitrary callback dependency discovery, provider
availability, external configuration formats, a policy server/editor, a new
CLI, and general documentation renderer changes are outside scope.
