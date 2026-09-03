# TICKET-007 — PURISTA handbook, website, and skill alignment

Recorded implementation: 2026-08-26. Status: **implemented; not accepted**.
Independent review controls acceptance and lifecycle promotion.

## Scope and contract trace

Implemented `CTR-GA-DOCS`, `CTR-GA-CLEANUP`, and `REQ-GA-WEBSITE` in the
PURISTA handbook, website projections, canonical `purista` skill, and synced
package overlay. No Harness runtime source or Voyage source was changed.

- Replaced the Guardrails and privacy handbook pages with one code-first,
  typed authoring path: `defineGuardrailAction(...)`, one inline
  `defineGuardrails({ config, actions })` declaration, phase-bound flow IDs,
  direct model aliases, explicit tool selectors, schema-bound sensitive-data
  codecs, and composition-time build preflight.
- Removed every public Guardrails file-configuration reference: YAML, NeMo,
  loaders, parser helpers, snake-case sensitive-data configuration, and policy
  file language. The public pages, cards, landing page projection, generated
  markdown data, canonical skill, and package skill overlay all describe the
  same inline camelCase configuration surface.
- Updated affected native TypeScript tool snippets to the builder-local
  `.tools(({ tool }) => ({ id: tool({ ... }) }))` pattern. Remaining raw
  `.tools({ ... })` snippets in this scope are explicit MCP tool literals, the
  retained integration boundary.
- Added a focused knowledge regression suite and equivalent knowledge-audit
  gate. It rejects every retired Guardrails configuration term and proves the
  canonical skill and package overlay remain aligned.

## Acceptance mapping

| Acceptance ID | Evidence |
| --- | --- |
| `AC-GA-WEBSITE-SUCCESS` | Handbook pages, cards, landing page, and skill teach opaque action tokens, inline configuration, typed phases, safe reason codes, sensitive-data policy/codec, build preflight, and the approval boundary. Website build passed. |
| `AC-GA-WEBSITE-FAILURE` | `guardrails-knowledge.test.mjs` and the integrated knowledge audit reject NeMo, YAML/config path, loader/parser, snake-case, and policy-file leftovers. The scoped scan has no matches. |
| `AC-GA-WEBSITE-RECOVERY` | The canonical skill was synchronized to the package overlay and verified byte-for-byte. Handbook, internal-link, skill, and knowledge audits pass after the clean cut. |

## Verification

Commands ran against the current dirty workspace; unrelated existing changes
were preserved.

1. `node purista/scripts/syncPackageSkills.mjs purista/packages/core` — pass.
2. `node --test purista/scripts/guardrails-knowledge.test.mjs` — pass, 2 tests.
3. `npm --prefix purista run audit:knowledge` — pass.
4. `npm --prefix purista run audit:skills` — pass.
5. `npm --prefix purista run audit:handbook` — pass.
6. `npm --prefix purista run audit:internal-links --workspace @purista/web` —
   pass, 1,283 generated pages. Two existing approved fragment redirects remain.
7. `npm --prefix purista run build --workspace @purista/web` — pass. Existing
   route-conflict and chunk-size warnings did not fail the build.
8. Scoped retired-surface and native-tool scans — pass. `git -C purista diff
   --check` — pass.

## Review repair

Independent review identified an inaccurate diagram/landing-page implication
that output rails ran after every model result, plus explanatory retention of
the removed file-configuration surface. The repair:

- makes the architecture diagram, landing page, handbook, cards, generated
  markdown projection, and canonical skill explicit: output rails run only on
  final answer candidates; intermediate tool-call responses skip output rails;
- removes file configuration, loader, and policy-file comparison language from
  the handbook, governance/ecosystem cards, markdown projection, and canonical
  skill plus its package overlay;
- extends both the focused test and knowledge audit to reject those exact
  retired phrases and to require the final-candidate rule in each projection,
  including the diagram.

Repair verification: the focused knowledge suite passed 3 tests; knowledge,
skills, and handbook audits passed; a full `npm --prefix purista run build
--workspace @purista/web` completed with exit code 0; and internal-link audit
checked 1,283 generated HTML pages with all links resolving. Existing route
projection and chunk-size warnings remain non-fatal.

## Final content-reuse repair

The final audit found repeated lifecycle prose across the website projections.
The repair creates `purista/web/src/data/guardrails-content.ts` as the one
website source for all five phases, the inline-authoring guarantee, the build
preflight guarantee, the final-candidate-only output rule, and the four
verification stages.

- The Guardrails landing page renders the shared final-output, authoring,
  build-preflight, and four-stage content.
- `GuardrailsArchitecture.astro` renders the shared phase descriptions and
  guarantee text. Its path now keeps requested tool rails inside the model loop
  and places final-output rails after that loop, before validation and delivery.
- `harness-markdown.ts` projects the shared five-phase matrix and four-stage
  table rather than restating either list.
- The handbook guide and governance card link their lifecycle prose to the
  canonical Guardrails overview instead of maintaining another phase matrix.
- The focused test and knowledge audit now require the data module, its five
  phases/four stages/final-only output invariant, and the imports in every
  TypeScript/Astro projection. They also require the handbook and card to link
  to the canonical overview.

Final repair verification: `node --test scripts/guardrails-knowledge.test.mjs`
passed 5 tests; `npm run audit:knowledge`, `npm run audit:skills`, and
`npm run audit:handbook` passed; `npm run build --workspace @purista/web`
completed with exit code 0; `npm run audit:internal-links --workspace
@purista/web` checked 1,283 generated HTML pages with all links resolving; and
`git diff --check` passed. The existing route-projection and chunk-size
warnings remain non-fatal.

## Handoff

Ticket implementation is ready for independent review. It is not
self-accepted.
