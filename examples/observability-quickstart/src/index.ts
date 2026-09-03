import { createObservedHarness } from './harness.js'
import { startOpenTelemetry } from './telemetry.js'

export async function runObservedSupportTicket(): Promise<string> {
  const telemetry = startOpenTelemetry()
  const harness = createObservedHarness()

  try {
    const session = await harness.getSession('support-demo')
    const result = await session.workflows.handle_ticket.run({
      ticketId: 'SUP-42',
      question: 'How can I update my billing address?',
    })
    if (result.status === 'interrupted') throw new Error(`Support workflow interrupted: ${result.interrupt.type}`)
    return result.output.answer
  } finally {
    await harness.shutdown()
    await telemetry.shutdown()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runObservedSupportTicket()
    .then(answer => console.log(answer))
    .catch(error => {
      console.error(error)
      process.exitCode = 1
    })
}
