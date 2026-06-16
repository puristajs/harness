import { createDelmSharedContextHarness, defaultDelmInput } from './harness.js'
import { formatCheckoutIncidentRun } from './scenario.js'

export { createDelmSharedContextHarness, defaultDelmInput, defaultDelmTasks, type DelmSharedContextHarnessOptions, type DelmSharedContextHarnessResult } from './harness.js'
export { ScriptedDelmProvider } from './scripted-provider.js'
export { checkoutIncidentEvidence, evidenceForTask } from './incident-data.js'
export { checkoutIncidentInput, checkoutIncidentQuestion, checkoutIncidentTasks, formatCheckoutIncidentRun } from './scenario.js'
export { createSharedContextStore, type SharedContextStore, type AdmissionResult, type SharedContextSnapshot, type UnfoldedEntry } from './shared-context.js'
export { createTaskQueue, type SharedTaskQueue, type TaskQueueSnapshotItem, type TaskStatus } from './task-queue.js'
export * from './schemas.js'

export async function runDelmSharedContextExample(): Promise<void> {
  const example = createDelmSharedContextHarness()
  try {
    const session = await example.harness.getSession('delm-demo')
    const result = await session.workflows.decentralized_research.prompt(defaultDelmInput(), {
      durable: { runId: 'delm-demo-run' }
    })
    console.log(formatCheckoutIncidentRun(result))
  } finally {
    await example.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runDelmSharedContextExample().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
