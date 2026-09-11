# TICKET-009 — coordinator verification

Status: accepted after independent coordinator inspection and final-source
verification on 2026-08-26. T004/T005 repairs and refreshed declarations passed.
No Voyage success is claimed.

## Independent inspection

The coordinator inspected the composed example and current decision guide,
the actual callback/type repairs discovered by compiling it, and the rendered
canonical guardrails and durable human-review pages. The decision table keeps
content, tool authority, immediate approval and durable application review
separate. The composition uses one approval provider, phase-specific rails,
parsed input, finite execution contexts and safe reason codes. The documentation
does not teach a rail block as an approval request.

Two documentation inaccuracies found during review were corrected: evidence
does not contain the enclosing event's effect/enforcement/correlation fields;
final-output rails also run on `stopWhen` finalization. The latter is a small
card text correction after the first successful full website build.

## Completed checks

- Fresh core and addon builds passed after the inline approval and both raw and
  helper attachment inference repairs. The coordinator then reran addon type
  tests and the composed example typecheck: pass, with no source annotations or
  casts added to the example.
- The composed example's seven runtime tests passed under the fresh declarations.
  Focused bank/review proof is in the Harness writer's report: four/twelve tests
  and both typechecks pass.
- `npm run build --workspace @purista/web` from PURISTA passed, including its
  normal Core/base HTTP/API documentation prebuild and Astro build: 1,086 pages.
- `npm run audit:internal-links` from `purista/web` passed over 1,283 generated
  HTML pages. The two existing approved fragment redirects belong to the
  pre-existing handbook restructuring; this task added no compatibility route.
- The coordinator used the in-app browser against the actual local Astro site.
  Guardrails rendered with its table, highlighted examples, navigation and
  contents list; the durable-review link opened the intended canonical page
  with claim/receipt recovery guidance. A viewport screenshot confirmed normal
  layout. The temporary browser tab was closed afterward.
- Coordinator reruns of PURISTA `audit:skills`, `audit:knowledge`,
  `audit:handbook` and `audit:api-docs` all exited zero. The API audit still
  reports its pre-existing missing summary/example inventory; that is not a
  claim of complete API prose coverage.
- Exact Harness skill mirror `--check` passed for
  `.artifacts/decision-skills/ai-harness`. PURISTA's exact Core target sync and
  strict extracted snippet checks are documented in the PURISTA writer report.
- Both repositories' `git diff --check` passed. The spec and plan checkers pass.

The final normal website build includes the `stopWhen` card correction and
passed again with 1,086 pages; its final link audit passed over 1,283 HTML pages.
All three actual extracted documentation snippets compiled against the final
built declarations with strict checks and `skipLibCheck:false`. The final
workspace build, lint and tests include the composed, bank and review examples.

Logs for the coordinator runs are under `/private/tmp/decision-website-build-final.log`,
`decision-web-links-final.log`, `decision-composed-example.log` and
`decision-audit-{skills,knowledge,handbook,api-docs}.log`.

## Detailed writer evidence

- [Harness docs, skill and executable composition](TICKET-009-ai-harness.md)
- [PURISTA handbook, canonical skill and mirror](TICKET-009-purista.md)

The final source-wide build/test/coverage and no-drift evidence is recorded in
[T010](TICKET-010.md). ACC-DOCS-SUCCESS, ACC-DOCS-FAILURE and ACC-DOCS-RECOVERY
are accepted: executable composition, checked boundary guidance and exact
canonical skill mirrors/snippets all passed. The unrelated Voyage blocker
remains recorded in T008 and prevents final delivery acceptance, not acceptance
of these verified documentation changes.
