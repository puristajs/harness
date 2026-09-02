# Practical evaluations

Seven small, fully offline examples for the generic evaluation substrate. They
are deliberately application-shaped: the Harness runs an evaluation matrix and
returns a bounded, content-free result, while each example owns its dataset,
task, scorer logic, and domain report.

Run them from this example directory:

```sh
npm install
npm run test
npm run build
npm run start
```

## Recipes

- `classification.ts` checks a routing label against a reference label.
- `extraction.ts` checks required invoice fields and puts only field names in
  bounded evidence.
- `rag.ts` checks that an answer includes its required citation reference.
- `translation.ts` is a judge-style async scorer adapter. Its `TranslationJudge`
  port is fake here; a real application can adapt any configured model or review
  service without making it a Harness dependency.
- `tool-calling-agent.ts` checks a tool-use trajectory against a declared tool
  policy.
- `subagent-as-tool.ts` checks both delegation and the parent’s combined answer.
- `workflow.ts` checks required workflow steps and also demonstrates
  `scoreEvaluation` on a saved application-owned observation without rerunning
  the task.

## What to replace in an application

Replace fixture datasets and task bodies first. A task receives the case input,
candidate configuration, trial identity, and an abort signal; it never receives
the reference assessment. A scorer receives the completed observation, including
the assessment when your application elects to provide one.

The fixtures that simulate model calls use `fixtureAccounting`. Production tasks
and judge scorers should report their actual model/provider identity, token use,
currency-specific cost, and optional trace/span correlation in `accounting` and
`correlation`. The result keeps task and scorer accounting separate, so a judge’s
cost cannot be mistaken for the candidate’s cost. This package does not emit
content to telemetry or require any observability, model, or evaluation vendor
SDK.

For the conceptual guide and operational choices, see the public Harness handbook
evaluation chapter.
