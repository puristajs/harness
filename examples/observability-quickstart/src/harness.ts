import { defineHarness, JsonLogger, type Logger, type ModelProvider } from '@purista/harness'
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
  return defineHarness({ name: 'support-agent' })
    .logger(options.logger ?? new JsonLogger({
      level: process.env['PURISTA_HARNESS_LOG_LEVEL'] === 'debug' ? 'debug' : 'info',
      bindings: { service: 'support-agent' },
    }))
    .telemetry({
      flavor: 'dual',
      contentCaptureMode: 'NO_CONTENT',
    })
    .models({
      assistant: {
        provider: options.provider ?? liveProvider(),
        model: process.env['OPENAI_MODEL'] ?? 'gpt-5-mini',
        capabilities: ['object'],
      },
    }).agent('answer_ticket', {
        model: 'assistant',
        input: ticketInput,
        output: ticketOutput,
        instructions: 'Give a concise support answer matching the output schema.',
      }).workflow('handle_ticket', {
        input: ticketInput,
        output: ticketOutput,
        delegation: { agents: ['answer_ticket'] },
        handler: async ctx => {
          ctx.logger.info('Handling support ticket.', { ticket_id: ctx.input.ticketId })
          ctx.metrics.counter('support.tickets.started', 1, { workflow: 'handle_ticket' })
          return ctx.metrics.duration(
            'support.ticket.duration',
            { workflow: 'handle_ticket' },
            () => ctx.agents.answer_ticket(ctx.input),
          )
        },
      })
    .build()
}
