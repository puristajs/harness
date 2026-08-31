import {
  defineHarness,
  inMemorySandbox,
  JsonLogger,
  type GovernanceApprovalProvider,
  type GovernanceApprovalRequest,
} from '@purista/harness'
import { FakeModelProvider } from '@purista/harness/testing'
import {
  createSensitiveDataActions,
  defineGuardrailAction,
  defineGuardrails,
  type SensitiveDataDetector,
} from '@purista/harness-guardrails'
import { z } from 'zod'

/** Options for the deterministic inline guardrails composition. */
export interface GuardrailsExampleOptions {
  readonly approval?: GovernanceApprovalProvider
  readonly decisionTimeoutMs?: number
  /** Optional application-owned detector used to observe or replace local inspection. */
  readonly detector?: SensitiveDataDetector
}

/** Observable counts captured by a no-request composition preflight. */
export interface GuardrailsExamplePreflight {
  readonly modelRequests: number
  readonly detectorInspections: number
  readonly toolInvocations: number
  readonly approvalRequests: number
}

/**
 * Fully local, deterministic guardrails example. Replace `FakeModelProvider`
 * with a normal provider addon in an application; rails remain unchanged.
 */
export function createGuardrailsExample(options: GuardrailsExampleOptions = {}) {
  const provider = new FakeModelProvider()
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
  provider.enqueueObject({
    object: null,
    usage,
    finishReason: 'tool_calls',
    toolCalls: [
      { id: 'call_lookup', name: 'lookup_status', arguments: { ticket: 'DEMO' } },
      { id: 'call_publish', name: 'publish_note', arguments: { message: '[secret]' } },
      { id: 'call_write', name: 'write', arguments: { path: '/workspace/note.txt', content: 'Reviewed note.' } },
    ],
  })
  provider.enqueueObject({ object: 'The [secret] answer.', usage, finishReason: 'stop' })
  const approvalRequests: GovernanceApprovalRequest[] = []
  const handledNotes: string[] = []
  const lifecycle: string[] = []
  let detectorInspections = 0
  const configuredDetector = options.detector ?? {
    id: 'example-local-detector',
    executionMode: 'local',
    supportedEntities: ['EMAIL_ADDRESS'],
    async inspect({ text }) {
      const start = text.indexOf('[email]')
      return start < 0
        ? { findings: [] }
        : { findings: [{ category: 'EMAIL_ADDRESS', start, end: start + '[email]'.length, score: 1 }] }
    },
  }
  const detector: SensitiveDataDetector = {
    ...configuredDetector,
    inspect: async (request) => {
      detectorInspections += 1
      return configuredDetector.inspect(request)
    },
  }
  const sensitiveDataActions = createSensitiveDataActions({ detector })
  const publishNoteRailSchema = z.strictObject({ message: z.string() })
  const publicStatusRailSchema = z.strictObject({ status: z.string() })
  const rails = defineGuardrails({
    config: {
      rails: {
        input: { flows: ['block unsafe content', 'remove secret marker', 'mask sensitive data on input'] },
        output: { flows: ['redact final answer'] },
        tool_input: { flows: ['redact note'] },
        tool_output: { flows: ['present public status'] },
      },
      sensitiveData: { input: { entities: ['EMAIL_ADDRESS'], maskToken: '<MASKED>', scoreThreshold: 0.6 } },
    },
    actions: {
      ...sensitiveDataActions,
      'mask sensitive data on input': sensitiveDataActions['mask sensitive data on input']!,
      'block unsafe content': defineGuardrailAction({
        phase: 'input',
        valueSchema: z.string(),
        evaluate: ({ value }) =>
          value.includes('[blocked]') ? { decision: 'block', reasonCode: 'unsafe_content' } : { decision: 'allow' },
      }),
      'remove secret marker': defineGuardrailAction({
        phase: 'input',
        valueSchema: z.string(),
        evaluate: ({ value }) =>
          value.includes('[secret]')
            ? {
                decision: 'transform',
                target: 'user_message',
                value: value.replaceAll('[secret]', '[redacted]'),
                reasonCode: 'secret_redacted',
              }
            : { decision: 'allow' },
      }),
      'redact note': defineGuardrailAction<'tool_input', typeof publishNoteRailSchema>({
        phase: 'tool_input',
        tools: ['publish_note'],
        valueSchema: publishNoteRailSchema,
        evaluate: ({ toolId, value }) => {
          lifecycle.push(`preflight:${toolId}`)
          return value.message.includes('[secret]')
            ? {
                decision: 'transform',
                target: 'tool_input',
                value: { ...value, message: value.message.replaceAll('[secret]', '[redacted]') },
                reasonCode: 'secret_redacted',
              }
            : { decision: 'allow' }
        },
      }),
      'present public status': defineGuardrailAction<'tool_output', typeof publicStatusRailSchema>({
        phase: 'tool_output',
        tools: ['lookup_status'],
        valueSchema: publicStatusRailSchema,
        evaluate: () => ({
          decision: 'transform' as const,
          target: 'tool_output' as const,
          value: { status: 'public status' },
          reasonCode: 'private_status_removed',
        }),
      }),
      'redact final answer': defineGuardrailAction({
        phase: 'output',
        valueSchema: z.string(),
        evaluate: ({ value }) =>
          value.includes('[secret]')
            ? {
                decision: 'transform',
                target: 'bot_message',
                value: value.replaceAll('[secret]', '[redacted]'),
                reasonCode: 'secret_redacted',
              }
            : { decision: 'allow' },
      }),
    },
  })
  const harness = defineHarness({ name: 'guardrails-example' })
    .logger(new JsonLogger({ level: 'error' }))
    .sandbox(inMemorySandbox())
    .defaults({ decisionTimeoutMs: options.decisionTimeoutMs ?? 1_000, toolTimeoutMs: 5_000 })
    .telemetry({ contentCaptureMode: 'NO_CONTENT' })
    .models({ assistant: { provider, model: 'fake', capabilities: ['object', 'tool_use'] } })
    .tool('lookup_status', {
        description: 'Read a synthetic ticket status.',
        input: z.strictObject({ ticket: z.string() }),
        output: z.strictObject({ status: z.string() }),
        handler: async (ctx) => {
          ctx.signal.throwIfAborted()
          lifecycle.push('handler:lookup_status')
          return { status: 'private status' }
        },
      })
    .tool('publish_note', {
        description: 'Publish a synthetic note after review.',
        input: z.strictObject({ message: z.string().trim(), visibility: z.literal('internal').default('internal') }),
        output: z.strictObject({ published: z.boolean() }),
        handler: async (ctx, input) => {
          ctx.signal.throwIfAborted()
          lifecycle.push('handler:publish_note')
          handledNotes.push(input.message)
          return { published: true }
        },
      })
    .agent('support', {
      model: 'assistant',
      input: z.string(),
      output: z.string(),
      instructions: ({ input }) => `Answer safely: ${input}`,
      tools: ['lookup_status', 'publish_note'],
      builtinTools: ['write'],
      permissions: { write: 'require_approval' },
      guardrails: rails,
    })
    .governance(({ native, rule }) => ({
      defaultEffect: 'allow',
      policies: [
        native({
          id: 'example-review',
          rules: [
            rule({
              id: 'synthetic-input-audit',
              tools: ['lookup_status', 'publish_note'],
              effect: 'audit',
              reasonCode: 'synthetic_input',
              when: (ctx) =>
                ctx.toolId === 'lookup_status' ? ctx.input.ticket === 'DEMO' : ctx.input.visibility === 'internal',
            }),
            rule({
              id: 'review-note',
              tools: ['publish_note', 'write'],
              effect: 'require_approval',
              reasonCode: 'note_review',
            }),
          ],
        }),
      ],
      approval: {
        async request(request, execution) {
          execution.signal.throwIfAborted()
          approvalRequests.push(request)
          lifecycle.push(`approval:${request.subject.toolId}`)
          // A real adapter forwards execution.signal and execution.deadline to its reviewer.
          return options.approval
            ? options.approval.request(request, execution)
            : { decision: 'approved', reasonCode: 'review_approved' }
        },
      },
    }))
    .build()

  return {
    harness,
    provider,
    approvalRequests,
    handledNotes,
    lifecycle,
    get detectorInspections() {
      return detectorInspections
    },
  }
}

/** Run the composed example without credentials, network calls, or durable business effects. */
export async function runGuardrailsExample(): Promise<string> {
  const { harness } = createGuardrailsExample()
  const session = await harness.getSession('example-session')
  try {
    return await session.agents.support.run('Where is [secret] [email]?')
  } finally {
    await session.release()
    await harness.shutdown()
  }
}

/** Build and shut down the complete inline guardrail composition without executing a request. */
export async function preflightGuardrailsExample(
  options: GuardrailsExampleOptions = {},
): Promise<GuardrailsExamplePreflight> {
  const example = createGuardrailsExample(options)
  try {
    return {
      modelRequests: example.provider.requests.length,
      detectorInspections: example.detectorInspections,
      toolInvocations: example.lifecycle.filter((entry) => entry.startsWith('handler:')).length,
      approvalRequests: example.approvalRequests.length,
    }
  } finally {
    await example.harness.shutdown()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runGuardrailsExample().then((answer) => process.stdout.write(`${answer}\n`))
}
