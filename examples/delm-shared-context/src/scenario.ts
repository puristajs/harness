import type { DelmWorkflowInput, DelmWorkflowOutput, SharedEntry, WorkerTask } from './schemas.js'

export const checkoutIncidentQuestion = [
  'Checkout failures are spiking for EU customers after the 14:00 deployment.',
  'Identify the likely cause and recommend the safest immediate action.'
].join(' ')

export const checkoutIncidentTasks: WorkerTask[] = [
  {
    id: 'logs-investigation',
    objective: 'Inspect application logs for checkout errors after the deploy. Publish a FACT report only.',
    dependsOn: []
  },
  {
    id: 'metrics-scope',
    objective: 'Check metrics to determine which region and checkout step are affected. Publish an OBSERVED report only.',
    dependsOn: []
  },
  {
    id: 'rollback-proposal',
    objective: 'Propose an immediate rollback without running a verification check. Publish a PATCH_SUMMARY with verified=false if the runbook evidence is unverified.',
    dependsOn: ['logs-investigation', 'metrics-scope']
  },
  {
    id: 'timeout-fix',
    objective: 'Verify whether increasing the payment authorization timeout fixes the reproduction. Publish a verified PATCH_SUMMARY only if reproduction evidence supports it.',
    dependsOn: ['logs-investigation', 'metrics-scope']
  }
]

export function checkoutIncidentInput(overrides: Partial<DelmWorkflowInput> = {}): DelmWorkflowInput {
  return {
    question: overrides.question ?? checkoutIncidentQuestion,
    workers: overrides.workers ?? 3,
    tasks: overrides.tasks ?? checkoutIncidentTasks
  }
}

export function formatCheckoutIncidentRun(result: DelmWorkflowOutput): string {
  const admitted = result.admittedEntries.map(formatEntry).join('\n')
  const rejected = result.rejectedReports.length > 0
    ? result.rejectedReports.map((item) => `- rejected ${item.taskId} from ${item.workerId}: ${item.reason}`).join('\n')
    : '- none'

  return [
    'Checkout Incident Investigation',
    '',
    result.answer,
    '',
    'Admitted shared context:',
    admitted || '- none',
    '',
    'Rejected reports:',
    rejected,
    '',
    `Durable context checkpoints written: ${result.checkpointCount}`
  ].join('\n')
}

function formatEntry(entry: SharedEntry): string {
  return `- ${entry.type} ${entry.id} (${entry.taskId}, ${entry.workerId}): ${entry.summary}`
}
