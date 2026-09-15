# Durable operations and approvals

A durable workflow declares `durable: true`, uses stable replay-safe step ids, and runs with a caller-owned run id:

```ts
const publish = defineWorkflow('publish', {
  input, output, durable: true,
  async handler(context) {
    const draft = await context.step('createDraft', () => createDraft(context.input))
    const decision = await context.externalWait.wait({
      waitId: `review:${context.runId}`,
      kind: 'human_review', schemaVersion: 'review-v1', definitionVersion: 'v1', deadline,
    })
    if (decision.status !== 'approved') return { published: false }
    return context.step('publishDraft', () => publishOnce(draft))
  },
})
```

Bind persistent `HarnessStorage` for restart recovery. A terminal failed run is not resumed; external waits and approval interruptions preserve an active durable continuation. Store application review records and effect receipts in application-owned persistence, authenticate reviewers, authorize the exact business action, and signal the correlated wait once.

Tool approval interruptions follow the same principle. Return them as expected API outcomes and resume the same run with the validated approval descriptor. Never convert them to HTTP 500 responses.
