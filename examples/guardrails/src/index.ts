import {
  builtInTools,
  defineAgent,
  defineHarness,
  defineTool,
  inMemorySandbox,
  JsonLogger,
  type JsonValue,
  type RunOutcome,
  type ToolApprovalDecision,
  type ToolApprovalRequest,
  sqliteHarnessStorage,
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
export async function createGuardrailsExample(options: GuardrailsExampleOptions = {}) {
  const provider = new FakeModelProvider()
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
  provider.enqueueText({
    content: '',
    usage,
    finishReason: 'tool_calls',
    toolCalls: [
      { id: 'call_lookup', name: 'lookupStatus', arguments: { ticket: 'DEMO' } },
      { id: 'call_publish', name: 'publishNote', arguments: { message: '[secret]', visibility: 'internal' } },
      { id: 'call_write', name: 'write', arguments: { path: '/workspace/note.txt', content: 'Reviewed note.' } },
    ],
  })
  provider.enqueueText({ content: 'The [secret] answer.', usage, finishReason: 'stop' })
  const approvalRequests: ToolApprovalRequest[] = []
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
  const publishNoteRailSchema = z.strictObject({ message: z.string(), visibility: z.literal('internal') })
  const publicStatusRailSchema = z.strictObject({ status: z.string() })
  const guardrailConfig = {
    rails: {
      input: { flows: ['block unsafe content', 'remove secret marker', 'mask sensitive data on input'] },
      output: { flows: ['redact final answer'] },
      tool_input: { flows: ['redact note'] },
      tool_output: { flows: ['present public status'] },
    },
    sensitiveData: { input: { entities: ['EMAIL_ADDRESS'] as string[], maskToken: '<MASKED>', scoreThreshold: 0.6 } },
  } as const
  const guardrailActions = {
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
      'redact note': defineGuardrailAction({
        phase: 'tool_input',
        tools: ['publishNote'],
        valueSchema: publishNoteRailSchema,
        evaluate: ({ toolId, value }) => {
          lifecycle.push(`preflight:${toolId}`)
          return value.message.includes('[secret]')
            ? {
                decision: 'transform',
                target: 'tool_input',
                value: { message: value.message.replaceAll('[secret]', '[redacted]'), visibility: value.visibility },
                reasonCode: 'secret_redacted',
              }
            : { decision: 'allow' }
        },
      }),
      'present public status': defineGuardrailAction({
        phase: 'tool_output',
        tools: ['lookupStatus'],
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
  } as const
  const rails = defineGuardrails<typeof guardrailActions, typeof guardrailConfig>({
    config: guardrailConfig,
    actions: guardrailActions,
  })
  const lookupStatus = defineTool('lookupStatus', {
        description: 'Read a synthetic ticket status.',
        input: z.strictObject({ ticket: z.string() }),
        output: z.strictObject({ status: z.string() }),
        handler: async (ctx) => {
          ctx.signal.throwIfAborted()
          lifecycle.push('handler:lookupStatus')
          return { status: 'private status' }
        },
      })
  const publishNote = defineTool('publishNote', {
        description: 'Publish a synthetic note after review.',
        input: z.strictObject({ message: z.string().trim(), visibility: z.literal('internal') }),
        output: z.strictObject({ published: z.boolean() }),
        handler: async (ctx, input) => {
          ctx.signal.throwIfAborted()
          lifecycle.push('handler:publishNote')
          handledNotes.push(input.message)
          return { published: true }
        },
      })
  const support = defineAgent('support', {
      model: 'chat',
      input: z.string(),
      output: z.string(),
      instructions: 'Answer safely and use the available tools when needed.',
      prompt: input => ({ role: 'user', content: input }),
      tools: [lookupStatus, publishNote, builtInTools.write],
      permissions: { write: 'require_approval' },
      guardrails: rails,
      governance: ({ native, rule }) => ({
      defaultEffect: 'allow',
      policies: [
        native({
          id: 'exampleReview',
          rules: [
            rule({
              id: 'syntheticInputAudit',
              tools: ['lookupStatus', 'publishNote'],
              effect: 'audit',
              reasonCode: 'synthetic_input',
              when: (ctx) =>
                ctx.toolId === 'lookupStatus' ? ctx.input.ticket === 'DEMO' : ctx.input.visibility === 'internal',
            }),
            rule({
              id: 'reviewNote',
              tools: ['publishNote', 'write'],
              effect: 'require_approval',
              reasonCode: 'note_review',
            }),
          ],
        }),
      ],
      }),
    })
  const storage = sqliteHarnessStorage({ file: ':memory:' })
  const harness = await defineHarness({
    name: 'guardrailsExample',
    revision: 'v1',
    defaults: { decisionTimeoutMs: options.decisionTimeoutMs ?? 1_000, toolTimeoutMs: 5_000 },
  }).addAgent(support).getInstance({
    models: { chat: { provider, model: 'fake' } },
    sandbox: inMemorySandbox(),
    storage,
    logger: new JsonLogger({ level: 'error' }),
    telemetry: { contentCaptureMode: 'NO_CONTENT' },
  })

  return {
    harness,
    provider,
    approvalRequests,
    handledNotes,
    lifecycle,
    storage,
    get detectorInspections() {
      return detectorInspections
    },
  }
}

/** Application-side approval/resume flow used by the example UI or worker. */
export async function runSupportRequest(
  example: Awaited<ReturnType<typeof createGuardrailsExample>>,
  sessionId: string,
  input: string,
  decide: (request: ToolApprovalRequest) => ToolApprovalDecision = request => ({
    approvalId: request.approvalId,
    approved: true,
    reason: 'Approved for the local example.',
  }),
  signal?: AbortSignal,
): Promise<RunOutcome<JsonValue>> {
  const session = await example.harness.getSession(sessionId)
  try {
    const first = await session.agents.support.run(input, signal ? { signal } : undefined)
    if (first.status === 'completed' || first.interrupt.type !== 'tool-approval') return first
    const decisions = first.interrupt.requests.map(request => {
      example.approvalRequests.push(request)
      example.lifecycle.push(`approval:${request.toolId}`)
      return decide(request)
    })
    return await session.agents.support.run(input, {
      ...(signal ? { signal } : {}),
      resume: {
        type: 'tool-approval',
        runId: first.runId,
        interruptId: first.interrupt.id,
        revision: first.interrupt.revision,
        eventId: `guardrails-example:${first.interrupt.id}`,
        decisions,
      },
    })
  } finally {
    await session.release()
  }
}

/** Run the composed example without credentials, network calls, or durable business effects. */
export async function runGuardrailsExample(): Promise<string> {
  const example = await createGuardrailsExample()
  try {
    const outcome = await runSupportRequest(example, 'example-session', 'Where is [secret] [email]?')
    if (outcome.status === 'interrupted') throw new Error(`Guardrails example interrupted: ${outcome.interrupt.type}`)
    if (typeof outcome.output !== 'string') throw new Error('Guardrails example returned a non-text output.')
    return outcome.output
  } finally {
    await example.harness.close()
    await example.storage.close()
  }
}

/** Build and shut down the complete inline guardrail composition without executing a request. */
export async function preflightGuardrailsExample(
  options: GuardrailsExampleOptions = {},
): Promise<GuardrailsExamplePreflight> {
  const example = await createGuardrailsExample(options)
  try {
    return {
      modelRequests: example.provider.requests.length,
      detectorInspections: example.detectorInspections,
      toolInvocations: example.lifecycle.filter((entry) => entry.startsWith('handler:')).length,
      approvalRequests: example.approvalRequests.length,
    }
  } finally {
    await example.harness.close()
    await example.storage.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runGuardrailsExample().then((answer) => process.stdout.write(`${answer}\n`))
}
