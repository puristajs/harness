import { defineAgent, defineHarness, defineWorkflow, JsonLogger, type Logger, type ModelProvider } from '@purista/harness'
import { openai } from '@purista/harness-openai'
import { z } from 'zod'

const ticketInput = z.object({
  ticketId: z.string().min(1),
  question: z.string().min(1),
})

const ticketOutput = z.object({
  answer: z.string().min(1),
})

function liveProvider(): ModelProvider {
  const apiKey = process.env['OPENAI_API_KEY']
  if (!apiKey) throw new Error('OPENAI_API_KEY is required.')
  return openai({ apiKey })
}

export function createObservedHarness(options: {
  provider?: ModelProvider
  logger?: Logger
} = {}) {
  const answerTicket = defineAgent('answerTicket', {
    input: ticketInput,
    output: ticketOutput,
    instructions: 'Give a concise support answer matching the output schema.',
    prompt: input => ({ role: 'user', content: input.question }),
  })
  const handleTicket = defineWorkflow('handleTicket', {
    input: ticketInput,
    output: ticketOutput,
    agents: [answerTicket],
    handler: async ctx => {
      ctx.logger.info('Handling support ticket.', { ticket_id: ctx.input.ticketId })
      ctx.metrics.counter('support.tickets.started', 1, { workflow: 'handleTicket' })
      return ctx.metrics.duration(
        'support.ticket.duration',
        { workflow: 'handleTicket' },
        () => ctx.agents.answerTicket.run(ctx.input, { callId: 'answerTicket' }),
      )
    },
  })
  return defineHarness({ name: 'supportAgent' }).addWorkflow(handleTicket).getInstance({
    logger: options.logger ?? new JsonLogger({
      level: process.env['PURISTA_HARNESS_LOG_LEVEL'] === 'debug' ? 'debug' : 'info',
      bindings: { service: 'support-agent' },
    }),
    telemetry: {
      flavor: 'dual',
      contentCaptureMode: 'NO_CONTENT',
    },
    model: { provider: options.provider ?? liveProvider(), model: process.env['OPENAI_MODEL'] ?? 'gpt-5-mini' },
  })
}
