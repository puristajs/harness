# TICKET-009 — PURISTA documentation and skill slice

Implementation report; not acceptance. Coordinator owns the full ticket,
rendered inspection, global builds, and dependency/status reconciliation.

## Readiness and ownership

Started writes only after coordinator readiness notice: T002/T004/T005/T007
accepted; reported plan checker digest
`54da8771fbb72321ef726b3f0583af375e90296cd9b13518e34067385cf1dbe3`.
Read the delivery contract, end-user-docs skill, canonical PURISTA docs skill,
web AGENTS/DESIGN, approved handbook IA, and handbook refactor plan.

The working tree already contained handbook restructuring, canonical skill05
changes and generated mirrors. Those changes were preserved. No route,
navigation, layout, package manifest, lockfile, source runtime, or Voyage source
was edited in this slice. The lifecycle agent owns Harness docs/skills/examples.

## Changed surfaces

- `purista/web/src/data/harness-markdown.ts` — Guardrails body only.
- Canonical handbook under `purista/web/src/content/handbook/harness/`:
  `secure-and-govern/guardrails.md`, `orchestrate-work/human-review.md`,
  `build-agents/errors-and-failure-behavior.md`, and
  `build-agents/streaming-cancellation-and-timeouts.md`.
- Harness cards: `guardrails-governance.mdx`, `human-review-gates.mdx`,
  `observability-operations.mdx`, `tools-and-skills.mdx`,
  `testing-and-evaluations.mdx`, and `ecosystem-packages.mdx`.
- `purista/web/src/content/handbook-cards/blocks/agent-pattern/guardrails.mdx`.
- Canonical `purista/skills/purista/references/05-ai-harness-runtime.md` and
  `11-evaluation-scenarios.md`; exact target sync refreshed their Core mirrors.

## Contract alignment

- Decision table separates content allow/block/phase transform, permission and
  policy effects, immediate approved/rejected, and durable wait plus application
  execution claim/receipt. Removed content-rail approval recipes.
- Custom actions declare phases; model checks declare phase; corrected raw tool
  JSON -> one schema parse -> shared frozen parsed input. Output rails cover
  final candidates only; tool-output projection is not reparsed.
- Shared approval provider handles static permission and policy demands once.
  Multi-tool rules narrow by `toolId`; approval/audit execution context is the
  second callback argument. Finite signal/deadline, malformed result, timeout,
  late completion and cancellation limits are explicit.
- Replaced removed addon errors with core decision errors. Exact evidence fields
  are `decisionId`, `source`, `phase`, optional `reasonCode`; enclosing events,
  audit records and errors own effect/enforcement/correlation/failureKind.
- Replaced the human-review card's read-approved-then-execute race with the
  tested immutable claim/idempotent executor/receipt sequence. Describes binding
  outside replay-skipped steps, concurrent resume, crash reconciliation and the
  no-post-admission-revocation limit. No invented framework review CRUD.
- `model.completed` accounts for provider completion, including tool-call
  responses and blocked candidates; `model.object` releases guarded final
  content. No duplicate accounting, opaque-reasoning inspection claim, or
  automatic direct-model-call coverage claim.
- Preserved detector capability tables, privacy deployment details and supported
  portable YAML vocabulary. Links point to current canonical pages and the
  existing `puristajs/harness` repository's tested examples.

## Verification

All commands were offline using installed tools from workspace root unless
shown otherwise. No installs, declaration suppression, or package changes.

| Command/check | Result |
| --- | --- |
| `node purista/scripts/syncPackageSkills.mjs purista/packages/core` | Exit 0; exact target only, no installed user-skill write |
| `npm --prefix purista run audit:skills` | Exit 0, 3 skills |
| `npm --prefix purista run audit:knowledge` | Exit 0 |
| `npm --prefix purista run audit:handbook` | Exit 0 |
| `npm --prefix purista run audit:api-docs` | Exit 0; reports pre-existing missing summaries/examples, same as baseline |
| `git -C purista diff --check` | Exit 0 |
| Removed/stale usage scan over the assigned website and skill surfaces | Exit 1 with no matches, expected success for `rg` absence check |
| Exact extracted documentation snippets against local public declarations | Exit 0, zero diagnostics, `strict: true`, `skipLibCheck: false` |

The scan used:

```sh
rg -n 'GuardrailBlockedError|GuardrailEvaluationError|OnPermissionAsk|OnPermission|onPermissionAsk|readApproved|toolName|after each model result|require settlement approval|approve-transfer' purista/web/src/data/harness-markdown.ts purista/web/src/content/handbook/harness purista/web/src/content/handbook-cards/harness purista/web/src/content/handbook-cards/blocks/agent-pattern purista/skills/purista/references/05-ai-harness-runtime.md purista/skills/purista/references/11-evaluation-scenarios.md
```

### Snippet proof and provenance

Extracted actual fenced code, not a handwritten substitute:

1. Both TypeScript fences from canonical `guardrails.md`, joined after removing
   only their intra-document `supportRails` import (the declaration precedes it).
2. First TypeScript fence from `guardrails-governance.mdx`: complete action
   registry including phase-specific custom actions, model check and native
   detector codec.
3. First TypeScript fence from the Guardrails body in `harness-markdown.ts`;
   obtained via the TypeScript AST's template-literal text, preserving escapes.

Final extracted files are in
`/private/var/folders/cm/j0yc1ng927j4pn29nrjbtbl80000gn/T/decision-doc-declarations-final-oDutSK/`:
`support.ts`, `claims.ts`, `markdown.ts`. Compile used installed TypeScript's
`createProgram` with `noEmit`, `strict`, `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`, and
`skipLibCheck: false`; ES2022/ESNext/Bundler. Exact aliases target local
`ai-harness/packages/{harness,harness-guardrails,harness-guardrails-native-privacy}/dist/index.d.ts`,
plus local Zod declarations and Node type roots. Coordinator had reported a
fresh successful Core build before this final check. No artifact was emitted
in the code repositories.

An initial source-mode check exposed the existing `rails.attach(agent(...))`
generic constraint and 12 missing installed `just-bash` declaration imports.
The public examples now use the same valid literal attachment pattern as the
tested composed example. The coordinator separately assigned and repaired the
addon generic constraint; this slice made no runtime change. No source-mode
success is claimed for that diagnostic experiment and no missing dependency
was suppressed. Public-declaration checking above completed without errors.

The composed, immediate and durable examples remain canonical executable
sources in `examples/guardrails`, `examples/bank-governance`, and
`examples/durable-human-review`. These docs link them rather than duplicate a
review subsystem. Runtime example verification is owned by the lifecycle agent
and coordinator; this report does not replace their test evidence.

## Handoff limits

PURISTA docs/skill edits and audits are complete for coordinator review. Root
owns rendered-site evidence and the full ticket's runtime/example/build gates.
This slice does not accept T009 or change T008's unrelated Voyage compilation
blocker. T010 remains dependent on the coordinator's accepted T008 and T009.

## Final built-declaration snapshot

After the coordinator's final successful offline workspace build and source
freeze, reran the same actual-fence extraction and strict declaration compiler
check for all three snippets. Result: **exit 0, zero diagnostics**.

The new extracted `support.ts`, `claims.ts`, and `markdown.ts` files are retained
in `/private/var/folders/cm/j0yc1ng927j4pn29nrjbtbl80000gn/T/decision-doc-declarations-final-wyFRSt/`.
Exact local Core/addon/native-privacy declaration aliases, local Zod/Node types,
`strict`, `noEmit`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
`noPropertyAccessFromIndexSignature`, and `skipLibCheck: false` were preserved.
No source was edited, no compiler output emitted, and no scanner fixtures or
consumer checker were run during this final snapshot. Only this evidence was
appended. Runtime coverage, site build/rendering, and the real consumer check
remain separate coordinator-owned evidence.
