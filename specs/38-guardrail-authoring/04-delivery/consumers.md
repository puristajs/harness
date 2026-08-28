# Consumer and documentation delivery

## CTR-GA-DOCS

The approved target is inline TypeScript authoring only. Teach one complete,
typechecked `defineGuardrails` object with two differently shaped tools, a
selected sensitive-data rail, a direct model alias, an unrelated tool that still
works, final-output validation, phase ordering and the four-stage guarantee
table from CTR-GA-CONFIG. Do not promise automatic guardrail/agent schema
compatibility.

Use the existing `examples/guardrails` workspace as the executable example. It
creates actual actions, builds the Harness composition with existing fake
model/detector adapters, and tests valid policy, action/phase rejection,
model/tool requirement failure and zero protected effects. It has no
configuration file and no configuration-validation command.

Harness-owned content: `packages/harness-guardrails/README.md`,
`docs/guides/guardrails.md`, `docs/guides/configuration.md`,
`docs/guides/extending-and-customizing.md`, `docs/reference/public-api.md`,
example README, and canonical `skills/ai-harness/SKILL.md` plus
configuration/agents-workflows-tools/testing references. Teach extracted
function-property types without mandatory arrow conversion or invented async
factories. Update all native `.tools` authoring examples touched by the clean
registration cut; no deprecated form remains in active guidance. Update
`.agent/IMPLEMENTATION.md` with the precise pattern. Remove every reference to
file configuration, its dependency, artifacts, scripts, commands and exports.

PURISTA-owned content: handbook
`web/src/content/handbook/harness/secure-and-govern/guardrails.md`,
`privacy-detectors.md`, secure-and-govern index factory snippet, relevant
native-tool snippets under handbook/harness,
`web/src/pages/harness/guardrails.astro`,
`web/src/components/harness/GuardrailsArchitecture.astro`, and
`web/src/data/harness-markdown.ts`. Also mechanically align the retained source
cards `web/src/content/handbook-cards/harness/{guardrails-governance,privacy-detectors,ecosystem-packages,tools-and-skills,sandboxing-and-mcp}.mdx`
and `web/src/content/handbook-cards/blocks/agent-pattern/guardrails.mdx`. No
card deletion or route rewrite is authorized. Preserve routes, navigation,
styling, existing component ownership and accessibility.

Use `web/src/data/guardrails-content.ts` for the five phase descriptions and
inline configuration/build guarantees shared by the page, diagram and Markdown
projection. This is content reuse, not a new site renderer. Handwritten guide
narrative can differ, but cannot redefine the option schema or lifecycle. Add
focused assertions to existing `scripts/knowledge-audit.mjs` for
phase/projection agreement and removed API names. Canonical
`purista/skills/purista/references/05-ai-harness-runtime.md`, its relevant
`11-evaluation-scenarios.md` acceptance scenarios, and package overlays follow
the builder/helper usage and inline-only configuration boundary. Use existing
skill sync/generation scripts, then audit; do not hand-edit generated copies.

## CTR-GA-CLEANUP

Apply breaking changes directly to current source, tests, examples, docs and
package exports. Delete obsolete NeMo types, metadata parsing, alias indirection,
directory discovery/scanning, file configuration APIs, the `yaml` dependency and
lockfile entries, schema/reference artifacts, generator/check scripts,
configuration-validation scripts, raw native tool overloads, permissive action
boolean/variance branches, sensitive tool flow-name options, duplicate resolved
definitions and stale examples. No deprecated aliases, alternate parser modes,
compatibility wrappers, migration guides, migration commands, old schema readers,
or data resets.

Retain the exact existing `scripts/verify-decision-consumers.mjs` guarantees:
Core AgentQueueBuilder source-overlay compilation and runtime tests plus the
separate strict freshly built public-declaration/runtime smoke. The consumer
script's explicit scope excludes Voyage. **Voyage is excluded from reads, writes,
tests and acceptance.** No unrelated sandbox/evaluation/storage refactor or
infrastructure change belongs here.

Extend the existing architecture gate with checks for every removed
configuration-file name/dependency/artifact/command and other removed
runtime/public names. Root `test:types` must include both core and guardrails
type suites. CI runs the existing build, architecture/tests and example tests;
it contains no configuration-specific generation or validation stage. Do not
weaken coverage thresholds. Emit a concise breaking release note describing the
new current API; no migration layer or migration walkthrough. Publishing/version
changes are outside this implementation plan; package tarball dry-run verifies
current exports locally.
