# Guardrail configuration

## CTR-GA-CONFIG

The addon owns one strict Zod `guardrailsConfigSchema`. Export
`GuardrailsConfigInput = z.input<typeof guardrailsConfigSchema>` and
`GuardrailsConfig = z.output<typeof guardrailsConfigSchema>`. Configuration is
authored only as a TypeScript object passed to `defineGuardrails`; there is no
file loader, parser, schema artifact, reference generator, configuration CLI or
second authoring format.

| Field | Accepted input / default |
| --- | --- |
| `rails` | Optional strict object, default `{}`. Only `input`, `output`, `tool_input`, `tool_output`, `retrieval` keys. |
| `rails.<phase>` | Optional strict object with required `flows` array. |
| `rails.<phase>.flows` | Ordered array of distinct nonempty, non-whitespace-only action IDs; no trimming or normalization. Empty array disables the phase. Duplicate IDs fail `invalid_shape`, preserving spec37 source identity rules. |
| `sensitiveData` | Optional strict object with only `input`, `output`, `retrieval` policy keys. |
| `sensitiveData.<phase>.entities` | Required nonempty array of distinct strings matching `^[A-Z][A-Z0-9_]{0,63}$`. |
| `sensitiveData.<phase>.maskToken` | Required string; at most 128 UTF-16 code units; empty string allowed. |
| `sensitiveData.<phase>.scoreThreshold` | Required finite number in `[0,1]`. |

All objects reject unknown properties, including `null` where optional means
omitted. No implicit scalar coercion. Sensitive policy mask/threshold remain
explicitly application-selected as in spec31; this authoring refactor introduces
no new security-policy defaults. Duplicate entities are a semantic parser check;
representable structural constraints are in Zod. Non-plain objects, cycles,
non-finite numbers, functions and non-JSON leaves fail before normalization.
Reuse core `isJsonValue`; do not copy its recursive implementation. The empty
rails default is the only input/output representation difference. Configuration
and arrays are cloned and frozen at compilation; mutating the original cannot
change an existing rail set.

Remove all `NeMo*` config exports, `models`, `instructions`, `prompts`,
`custom_data`, `sourcePath`, `rails.config`, snake_case policy keys,
`modelAliases`, configuration-file APIs, and generated configuration
outputs. Model-backed actions name a Harness alias directly through
`modelCheckRail({ model, ... })`. Policy never configures provider credentials,
endpoints, or instructions.

`defineGuardrails<const A extends GuardrailActions>(options:
DefineGuardrailsOptions<A>): Guardrails<A>` keeps action keys/phases literal.
`options.config` accepts only `GuardrailsConfigFor<NoInfer<A>>`.
`GuardrailsConfigFor<A>` derives from the schema input using mapped types:
replace each phase's `flows` element with the keys in A whose token phase is
that phase. Other fields are reused, not redeclared. No plain broad
`GuardrailsConfigInput` union arm may silently defeat these checks. `actions` is
required; empty sets/configs remain valid. Existing observability and action
timeout options remain unchanged.

Compilation always verifies action existence, phase, timeout, sensitive policy
and supported entities, including for TypeScript callers. Only configured
actions contribute requirements. Unused entries in `actions` do not create
model/tool requirements. Reserved sensitive flow IDs and policy bindings come
from one addon-owned catalog shared by the factory and compiler; the schema does
not duplicate that semantic catalog.

### Verification boundaries

| Stage | Guarantees | Does not guarantee |
| --- | --- | --- |
| TypeScript inline configuration | Action ID/phase correlation and callback types | Arbitrary Zod refinement equivalence |
| Zod parse/compile | Structural fields, defaults, semantic action/policy checks | Provider availability or arbitrary schema inclusion |
| Harness `.build()` | Required models/tools/capabilities before invocation | Model, detector, tool, session, sandbox or network invocation |
| Invocation | Selected payload parsing and existing decision behavior | Retrofitting semantic compatibility into an unrelated rail |

## CTR-GA-GENERATION

Zod remains the canonical runtime validator and source of the exported input and
output types. It produces no committed JSON Schema, Markdown reference,
configuration-specific package artifact, generator, check script, or public
generation API. Existing TypeScript declaration emit is the only public type
projection. Documentation describes the inline object at the API call site and
must not copy an independent option table.
