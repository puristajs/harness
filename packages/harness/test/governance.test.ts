import { z } from 'zod'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

import {
  createDecisionEvidence,
  DecisionEvaluationError,
  defineHarness,
  HarnessConfigError,
  inMemorySandbox,
  OperationCancelledError,
  PermissionDeniedError,
  PolicyDeniedError,
  serializeError,
} from '../src/index.js'
import type { DecisionEvidence, GovernanceConfig, RunEvent, ToolHandlerContext } from '../src/index.js'
import { applyToolExposure, enforceToolGovernance } from '../src/governance/index.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'
import { RecordingTelemetry } from '../src/testing/recordingTelemetry.js'
import type { ObjectRequest } from '../src/ports/model-provider.js'

const transferInput = z.object({
  from: z.string(),
  to: z.string(),
  amount: z.number(),
  balance: z.number(),
})

function bankTools(onTransfer: () => void = () => {}) {
  return {
    transfer_funds: {
      description: 'Transfer funds between two accounts.',
      input: transferInput,
      output: z.object({ approved: z.boolean(), reference: z.string() }),
      handler: async (_ctx: ToolHandlerContext, input: z.output<typeof transferInput>) => {
        onTransfer()
        return { approved: true, reference: `${input.from}-${input.to}-${input.amount}` }
      },
    },
  }
}

describe('governance policies', () => {
  it('interrupts the whole tool batch before any side effect when approval is required', async () => {
    const model = new FakeModelProvider()
    model.enqueue({
      object: {},
      toolCalls: [
        {
          id: 'call-small-transfer',
          name: 'transfer_funds',
          arguments: { from: 'checking', to: 'brokerage', amount: 100, balance: 5_000 },
        },
        {
          id: 'call-large-transfer',
          name: 'transfer_funds',
          arguments: { from: 'checking', to: 'brokerage', amount: 1_200, balance: 5_000 },
        },
      ],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'tool_calls',
    })
    let transfers = 0

    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object', 'tool_use'] } })
      .tools(
        bankTools(() => {
        transfers += 1
        }),
      )
      .agent('banker', {
        model: 'fast',
        input: z.string(),
        output: z.string(),
        instructions: 'Transfer funds.',
        tools: ['transfer_funds'],
        builtinTools: false,
      })
      .governance(({ native, rule }) => ({
        defaultEffect: 'allow',
        policies: [
          native({
            id: 'bank-transfer-controls',
            rules: [
              rule({
                id: 'large-transfer-approval',
                effect: 'require_approval',
                tools: ['transfer_funds'],
                when: ({ input }) => input.amount > 1_000,
              }),
            ],
          }),
        ],
      }))
      .build()

    const session = await harness.getSession('policy-interrupt')
    const events = []
    let outcome
    for await (const event of session.agents.banker.stream('transfer')) {
      events.push(event)
      if (event.type === 'run.finished') outcome = event.outcome
    }

    expect(transfers).toBe(0)
    expect(events.filter(event => event.type === 'tool.input.available')).toHaveLength(2)
    expect(outcome).toMatchObject({
      status: 'interrupted',
      interrupt: {
        type: 'tool-approval',
        requests: [
          expect.objectContaining({
            toolId: 'transfer_funds',
            callId: 'call-large-transfer',
            input: expect.objectContaining({ amount: 1_200 }),
          }),
        ],
      },
    })
  })

  it('resumes an approved tool call from the persisted model turn', async () => {
    const model = new FakeModelProvider()
    model.enqueue({
      object: {},
      toolCalls: [
        {
          id: 'call-transfer',
          name: 'transfer_funds',
          arguments: { from: 'checking', to: 'brokerage', amount: 1_200, balance: 5_000 },
        },
      ],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'tool_calls',
    })
    let transfers = 0
    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object', 'tool_use'] } })
      .tools(
        bankTools(() => {
        transfers += 1
        }),
      )
      .agent('banker', {
        model: 'fast',
        input: z.string(),
        output: z.string(),
        instructions: 'Transfer funds.',
        tools: ['transfer_funds'],
        builtinTools: false,
      })
      .governance(({ native, rule }) => ({
        defaultEffect: 'allow',
        policies: [
          native({
            id: 'bank-transfer-controls',
            rules: [
              rule({
                id: 'large-transfer-approval',
                effect: 'require_approval',
                tools: ['transfer_funds'],
                when: ({ input }) => input.amount > 1_000,
              }),
            ],
          }),
        ],
      }))
      .build()
    const session = await harness.getSession('policy-resume')
    const first = await session.agents.banker.run('transfer')
    expect(first.status).toBe('interrupted')
    if (first.status !== 'interrupted' || first.interrupt.type !== 'tool-approval') {
      throw new Error('Expected a tool approval interruption.')
    }
    const request = first.interrupt.requests[0]
    if (!request) throw new Error('Expected one approval request.')
    expect(transfers).toBe(0)

    model.enqueue({ object: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
    const resumedEvents = []
    for await (const event of session.agents.banker.stream('transfer', {
      resume: {
        type: 'tool-approval',
        runId: first.runId,
        interruptId: first.interrupt.id,
        revision: first.interrupt.revision,
        eventId: 'review-decision-1',
        decisions: [{ approvalId: request.approvalId, approved: true }],
      },
    })) {
      resumedEvents.push(event)
    }

    expect(transfers).toBe(1)
    expect(model.requests).toHaveLength(2)
    expect(resumedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'approval.responded', approvalId: request.approvalId, approved: true }),
        expect.objectContaining({ type: 'tool.started', callId: 'call-transfer' }),
        expect.objectContaining({
          type: 'run.finished',
          outcome: expect.objectContaining({ status: 'completed', output: 'done' }),
        }),
      ]),
    )
    const resume = {
      type: 'tool-approval' as const,
      runId: first.runId,
      interruptId: first.interrupt.id,
      revision: first.interrupt.revision,
      eventId: 'review-decision-1',
      decisions: [{ approvalId: request.approvalId, approved: true }],
    }
    await expect(session.agents.banker.run('transfer', { resume })).resolves.toMatchObject({
      status: 'completed',
      output: 'done',
    })
    await expect(
      session.agents.banker.run('transfer', { resume: { ...resume, eventId: 'conflicting-decision' } }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(transfers).toBe(1)
    expect(model.requests).toHaveLength(2)

    model.enqueue({
      object: {},
      toolCalls: [
        {
          id: 'call-transfer-rejected',
          name: 'transfer_funds',
          arguments: { from: 'checking', to: 'brokerage', amount: 1_500, balance: 5_000 },
        },
      ],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'tool_calls',
    })
    const rejectedSession = await harness.getSession('policy-reject-resume')
    const pendingRejection = await rejectedSession.agents.banker.run('transfer')
    if (pendingRejection.status !== 'interrupted' || pendingRejection.interrupt.type !== 'tool-approval') {
      throw new Error('Expected a tool approval interruption.')
    }
    const rejectedRequest = pendingRejection.interrupt.requests[0]
    if (!rejectedRequest) throw new Error('Expected one approval request.')
    model.enqueue({
      object: 'cancelled',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'stop',
    })
    await expect(
      rejectedSession.agents.banker.run('transfer', {
        resume: {
          type: 'tool-approval',
          runId: pendingRejection.runId,
          interruptId: pendingRejection.interrupt.id,
          revision: pendingRejection.interrupt.revision,
          eventId: 'review-decision-2',
          decisions: [
            { approvalId: rejectedRequest.approvalId, approved: false, reason: 'Transfer was not expected.' },
          ],
        },
      }),
    ).resolves.toMatchObject({ status: 'completed', output: 'cancelled' })
    expect(transfers).toBe(1)
    const rejectionFollowUp = model.requests[3] as ObjectRequest
    expect(rejectionFollowUp.messages.find(message => message.role === 'tool')).toMatchObject({
      content: expect.stringContaining('Transfer was not expected.'),
    })
  })

  it('blocks denied tool calls before the tool handler runs', async () => {
    const model = new FakeModelProvider()
    model.enqueue({
      object: {},
      toolCalls: [
        {
          id: 'call-transfer',
          name: 'transfer_funds',
          arguments: { from: 'checking', to: 'brokerage', amount: 120, balance: 80 },
        },
      ],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'tool_calls',
    })
    model.enqueue({ object: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
    let transfers = 0

    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object', 'tool_use'] } })
      .tools(
        bankTools(() => {
        transfers += 1
        }),
      )
      .agent('banker', {
        model: 'fast',
        input: z.string(),
        output: z.string(),
        instructions: 'Transfer funds and recover from tool errors.',
        tools: ['transfer_funds'],
        builtinTools: false,
      })
      .governance(({ native, rule }) => ({
        defaultEffect: 'allow',
        policies: [
          native({
            id: 'bank-transfer-controls',
            rules: [
              rule({
                id: 'insufficient-funds',
                effect: 'deny',
                tools: ['transfer_funds'],
                when: ({ input }) => input.balance < input.amount,
                reasonCode: 'insufficient_funds',
              }),
            ],
          }),
        ],
      }))
      .build()

    const session = await harness.getSession('policy-deny')
    await expect(session.agents.banker.run('transfer')).resolves.toMatchObject({ status: 'completed', output: 'done' })
    expect(transfers).toBe(0)

    const secondModelRequest = model.requests[1] as ObjectRequest
    const toolMessage = secondModelRequest.messages.find(message => message.role === 'tool')
    expect(JSON.parse(toolMessage?.content ?? '{}')).toMatchObject({
      code: 'POLICY_DENIED',
      meta: {
        evidence: {
          source: { kind: 'policy', id: 'bank-transfer-controls', ruleId: 'insufficient-funds' },
          phase: 'policy',
          reasonCode: 'insufficient_funds',
        },
      },
    })
  })

  it('records shadow decisions without blocking tool execution', async () => {
    const model = new FakeModelProvider()
    model.enqueue({
      object: {},
      toolCalls: [
        {
          id: 'call-transfer',
          name: 'transfer_funds',
          arguments: { from: 'checking', to: 'brokerage', amount: 12_000, balance: 20_000 },
        },
      ],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'tool_calls',
    })
    model.enqueue({ object: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
    let transfers = 0

    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object', 'tool_use'] } })
      .tools(
        bankTools(() => {
        transfers += 1
        }),
      )
      .agent('banker', {
        model: 'fast',
        input: z.string(),
        output: z.string(),
        instructions: 'Transfer funds.',
        tools: ['transfer_funds'],
        builtinTools: false,
      })
      .governance(({ native, rule }) => ({
        mode: 'shadow',
        defaultEffect: 'allow',
        policies: [
          native({
            id: 'bank-transfer-controls',
            rules: [
              rule({
                id: 'hard-limit',
                effect: 'deny',
                tools: ['transfer_funds'],
                when: ({ input }) => input.amount > 10_000,
              }),
            ],
          }),
        ],
      }))
      .build()

    const session = await harness.getSession('policy-shadow')
    const events = []
    for await (const event of session.agents.banker.observe('transfer')) {
      events.push(event)
    }

    expect(transfers).toBe(1)
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'policy.evaluated',
          enforced: false,
          effect: 'deny',
          evidence: expect.objectContaining({ source: expect.objectContaining({ ruleId: 'hard-limit' }) }),
        }),
      ]),
    )
  })

  it('can hide tools before the model call without requiring execution policies', async () => {
    const model = new FakeModelProvider()
    model.enqueue({ object: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })

    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object', 'tool_use'] } })
      .tools(bankTools())
      .agent('banker', {
        model: 'fast',
        input: z.string(),
        output: z.string(),
        instructions: 'Transfer funds.',
        tools: ['transfer_funds'],
        builtinTools: false,
      })
      .governance(({ exposureRule }) => ({
        exposure: {
          id: 'tenant-tool-exposure',
          rules: [
            exposureRule({
              id: 'hide-transfers',
              effect: 'hide',
              tools: ['transfer_funds'],
            }),
          ],
        },
      }))
      .build()

    const session = await harness.getSession('policy-exposure')
    const events = []
    for await (const event of session.agents.banker.observe('transfer')) {
      events.push(event)
    }

    const firstRequest = model.requests[0] as ObjectRequest
    expect(firstRequest.tools).toEqual([])
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'policy.exposure',
          effect: 'hide',
          enforced: true,
          evidence: expect.objectContaining({
            source: expect.objectContaining({ id: 'tenant-tool-exposure', ruleId: 'hide-transfers' }),
          }),
          toolId: 'transfer_funds',
          invocationId: expect.any(String),
        }),
      ]),
    )
  })

  it('records shadow exposure decisions without hiding tools', async () => {
    const model = new FakeModelProvider()
    model.enqueue({ object: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })

    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object', 'tool_use'] } })
      .tools(bankTools())
      .agent('banker', {
        model: 'fast',
        input: z.string(),
        output: z.string(),
        instructions: 'Transfer funds.',
        tools: ['transfer_funds'],
        builtinTools: false,
      })
      .governance(({ exposureRule }) => ({
        mode: 'shadow',
        exposure: {
          rules: [exposureRule({ id: 'hide-transfers', effect: 'hide', tools: ['transfer_funds'] })],
        },
      }))
      .build()

    const session = await harness.getSession('policy-exposure-shadow')
    const events = []
    for await (const event of session.agents.banker.observe('transfer')) {
      events.push(event)
    }

    const firstRequest = model.requests[0] as ObjectRequest
    expect(firstRequest.tools?.map(tool => tool.name)).toContain('transfer_funds')
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'policy.exposure', effect: 'hide', enforced: false, toolId: 'transfer_funds' }),
      ]),
    )
  })

  it('fails closed when a native predicate returns a non-boolean value', async () => {
    const model = new FakeModelProvider()
    model.enqueue({
      object: {},
      toolCalls: [
        {
          id: 'call-transfer',
          name: 'transfer_funds',
          arguments: { from: 'checking', to: 'brokerage', amount: 120, balance: 500 },
        },
      ],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'tool_calls',
    })
    let transfers = 0
    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object', 'tool_use'] } })
      .tools(
        bankTools(() => {
        transfers += 1
        }),
      )
      .agent('banker', {
        model: 'fast',
        input: z.string(),
        output: z.string(),
        instructions: 'Transfer.',
        tools: ['transfer_funds'],
        builtinTools: false,
      })
      .governance(({ native, rule }) => ({
        policies: [
          native({
            id: 'strict-predicate',
            rules: [
              rule({ id: 'must-be-boolean', effect: 'allow', tools: ['transfer_funds'], when: () => null as never }),
            ],
          }),
        ],
      }))
      .build()

    const session = await harness.getSession('predicate-invalid')
    await expect(session.agents.banker.run('transfer')).rejects.toMatchObject({
      code: 'DECISION_EVALUATION_ERROR',
      meta: { failureKind: 'invalid_result' } satisfies Partial<DecisionEvaluationError['meta']>,
    })
    expect(transfers).toBe(0)
  })

  it('fails closed when an exposure predicate returns a truthy non-boolean value', async () => {
    const model = new FakeModelProvider()
    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object', 'tool_use'] } })
      .tools(bankTools())
      .agent('banker', {
        model: 'fast',
        input: z.string(),
        output: z.string(),
        instructions: 'Transfer.',
        tools: ['transfer_funds'],
        builtinTools: false,
      })
      .governance(({ exposureRule }) => ({
        exposure: {
          rules: [
            exposureRule({
              id: 'must-be-boolean',
              effect: 'hide',
              tools: ['transfer_funds'],
              when: () => 'yes' as never,
            }),
          ],
        },
      }))
      .build()

    const session = await harness.getSession('exposure-invalid')
    await expect(session.agents.banker.run('transfer')).rejects.toMatchObject({
      code: 'DECISION_EVALUATION_ERROR',
      meta: { failureKind: 'invalid_result' },
    })
    expect(model.requests).toHaveLength(0)
  })

  it('rejects legacy native-rule fields and malformed reason codes at build time', () => {
    const model = new FakeModelProvider()
    const build = (rule: unknown) =>
      defineHarness()
        .sandbox(inMemorySandbox())
        .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
        .tools(bankTools())
        .agent('banker', {
          model: 'fast',
          input: z.string(),
          output: z.string(),
          instructions: 'x',
          tools: ['transfer_funds'],
          builtinTools: false,
        })
        .governance({ policies: [{ kind: 'native', id: 'strict-config', rules: [rule] } as never] })
        .build()

    expect(() => build({ id: 'legacy', effect: 'deny', message: 'legacy prose' })).toThrow(HarnessConfigError)
    expect(() => build({ id: 'bad-code', effect: 'deny', reasonCode: 'Bad prose' })).toThrow(HarnessConfigError)
  })

  it('rejects obsolete and malformed JavaScript exposure configuration at build time', () => {
    const model = new FakeModelProvider()
    const build = (exposure: unknown) =>
      defineHarness()
        .sandbox(inMemorySandbox())
        .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
        .tools(bankTools())
        .agent('banker', {
          model: 'fast',
          input: z.string(),
          output: z.string(),
          instructions: 'x',
          tools: ['transfer_funds'],
          builtinTools: false,
        })
        .governance({ exposure } as never)
        .build()

    expect(() => build({ rules: [{ id: 'legacy', effect: 'hide', message: 'legacy prose' }] })).toThrow(
      HarnessConfigError,
    )
    expect(() => build({ rules: [{ id: 'bad-effect', effect: 'block' }] })).toThrow(HarnessConfigError)
    expect(() => build({ rules: [{ id: 'bad-tools', effect: 'hide', tools: ['transfer_funds', 1] }] })).toThrow(
      HarnessConfigError,
    )
    expect(() => build({ rules: [{ id: 'bad-when', effect: 'hide', when: true }] })).toThrow(HarnessConfigError)
    expect(() => build({ rules: [], metadata: {} })).toThrow(HarnessConfigError)
  })

  it('validates policy tool references at build time', () => {
    const model = new FakeModelProvider()

    expect(() =>
      defineHarness()
        .sandbox(inMemorySandbox())
        .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
        .tools(bankTools())
        .agent('banker', {
          model: 'fast',
          input: z.string(),
          output: z.string(),
          instructions: 'x',
          tools: ['transfer_funds'],
          builtinTools: false,
        })
        .governance(({ native, rule }) => ({
          policies: [
            native({
              id: 'bad-policy',
              rules: [rule({ id: 'missing-tool', effect: 'deny', tools: ['wire_money'], when: () => true })],
            }),
          ],
        }))
        .build(),
    ).toThrow(/unknown tool/i)
  })

  it('validates exposure tool references at build time', () => {
    const model = new FakeModelProvider()

    expect(() =>
      defineHarness()
        .sandbox(inMemorySandbox())
        .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
        .tools(bankTools())
        .agent('banker', {
          model: 'fast',
          input: z.string(),
          output: z.string(),
          instructions: 'x',
          tools: ['transfer_funds'],
          builtinTools: false,
        })
        .governance(({ exposureRule }) => ({
          exposure: {
            rules: [exposureRule({ id: 'missing-tool', effect: 'hide', tools: ['wire_money'] })],
          },
        }))
        .build(),
    ).toThrow(/unknown tool/i)
  })

  it('exports policy errors on the public surface', () => {
    expect(new PolicyDeniedError(evidence(), 'policy_deny').code).toBe('POLICY_DENIED')
  })
})

function invocation(
  overrides: Partial<Parameters<typeof enforceToolGovernance>[0]> = {},
): Parameters<typeof enforceToolGovernance>[0] {
  return {
    toolId: 'bash',
    input: { command: 'safe' },
    callId: 'call',
    agentId: 'agent',
    runId: 'run',
    sessionId: 'session',
    invocationId: 'run',
    step: 0,
    signal: new AbortController().signal,
    decisionTimeoutMs: 1000,
    metadata: {},
    ...overrides,
  }
}

function evidence(): DecisionEvidence {
  return createDecisionEvidence({
    occurrence: { invocationId: 'run', step: 0 },
    source: { kind: 'policy', id: 'policy' },
    phase: 'policy',
    ordinal: 0,
  })
}

function expectedId(
  id: string,
  ordinal: number,
  ruleId: string | null = null,
  phase = 'policy',
  toolId = 'bash',
): string {
  return `decision_${createHash('sha256')
    .update(
      JSON.stringify([
        'run',
        'run',
        phase,
        0,
        toolId,
        phase === 'exposure' ? null : 'call',
        phase === 'exposure' ? 'exposure' : 'policy',
        id,
        null,
        ruleId,
        ordinal,
      ]),
    )
    .digest('hex')}`
}

function buildGovernance(config: unknown) {
  return defineHarness()
    .sandbox(inMemorySandbox())
    .models({ fast: { provider: new FakeModelProvider(), model: 'fake', capabilities: ['object'] } })
    .governance(config as never)
    .build()
}

describe('governance contract regressions', () => {
  afterEach(() => vi.useRealTimers())

  it('emits a content-free policy span and metrics for external evaluators', async () => {
    const telemetry = new RecordingTelemetry()
    await enforceToolGovernance(
      invocation({
      telemetry,
      input: { command: 'SYNTHETIC_PRIVATE_COMMAND' },
      governance: {
        policies: [{ id: 'opa-transfer', version: 'v1', engine: 'opa', evaluate: () => ({ effect: 'allow' }) }],
      },
      }),
    )

    expect(telemetry.spans).toEqual(
      expect.arrayContaining([
      expect.objectContaining({
        name: 'harness.policy.evaluate',
        attrs: expect.objectContaining({
          'openinference.span.kind': 'GUARDRAIL',
          'harness.policy.engine': 'opa',
          'harness.policy.name': 'opa-transfer',
          'harness.policy.version': 'v1',
          'harness.tool.id': 'bash',
        }),
      }),
      ]),
    )
    expect(telemetry.metrics.map(metric => metric.name)).toEqual(
      expect.arrayContaining(['harness.policy.evaluations', 'harness.policy.duration']),
    )
    expect(JSON.stringify(telemetry)).not.toContain('SYNTHETIC_PRIVATE_COMMAND')
  })

  it('emits the same content-free policy telemetry for native rules', async () => {
    const telemetry = new RecordingTelemetry()
    await enforceToolGovernance(
      invocation({
      telemetry,
      governance: {
        defaultEffect: 'allow',
          policies: [
            {
          kind: 'native',
          id: 'native-transfer-controls',
          version: 'v1',
          rules: [{ id: 'limit-check', effect: 'deny', when: () => false }],
      },
          ],
        },
      }),
    )

    expect(telemetry.spans).toEqual(
      expect.arrayContaining([
      expect.objectContaining({
        name: 'harness.policy.evaluate',
        attrs: expect.objectContaining({
          'openinference.span.kind': 'GUARDRAIL',
          'harness.policy.engine': 'native',
          'harness.policy.name': 'native-transfer-controls',
          'harness.policy.version': 'v1',
          'harness.policy.rule_id': 'limit-check',
          'harness.policy.effect': 'deny',
          'harness.policy.phase': 'pre',
        }),
      }),
      ]),
    )
    expect(JSON.stringify(telemetry)).not.toContain('safe')
  })

  it('counts enforced denials and approval requests without recording decision content', async () => {
    const denialTelemetry = new RecordingTelemetry()
    await expect(
      enforceToolGovernance(
        invocation({
      telemetry: denialTelemetry,
      governance: {
        policies: [{ kind: 'native', id: 'native', rules: [{ id: 'blocked', effect: 'deny' }] }],
      },
        }),
      ),
    ).rejects.toBeInstanceOf(PolicyDeniedError)
    expect(denialTelemetry.metrics).toEqual(
      expect.arrayContaining([
      expect.objectContaining({
        name: 'harness.policy.denials',
        attrs: expect.objectContaining({
          'harness.policy.engine': 'native',
          'harness.policy.rule_id': 'blocked',
        }),
      }),
      ]),
    )

    const approvalTelemetry = new RecordingTelemetry()
    const approval = await enforceToolGovernance(
      invocation({
      telemetry: approvalTelemetry,
      governance: {
        policies: [{ kind: 'native', id: 'native', rules: [{ id: 'review', effect: 'require_approval' }] }],
      },
      }),
    )
    expect(approval).toMatchObject({ decision: 'approval_required' })
    expect(approvalTelemetry.metrics).toEqual(
      expect.arrayContaining([
      expect.objectContaining({
        name: 'harness.approval.requests',
        attrs: expect.objectContaining({
          'harness.policy.engine': 'native',
          'harness.policy.rule_id': 'review',
          'harness.approval.status': 'requested',
        }),
      }),
      ]),
    )
    expect(JSON.stringify(approvalTelemetry)).not.toContain('safe')
  })

  it('configures external policy evaluators with the shared Harness context', async () => {
    const configureHarnessContext = vi.fn()
    const harness = buildGovernance({
      policies: [
        {
        id: 'external',
        engine: 'opa',
        configureHarnessContext,
        evaluate: () => undefined,
        },
      ],
    })
    expect(configureHarnessContext).toHaveBeenCalledWith(
      expect.objectContaining({
      harnessName: expect.any(String),
      telemetry: expect.any(Object),
      }),
    )
    await harness.shutdown()
  })

  it.each(['bash', 'write', 'edit'] as const)('preserves permission wildcard semantics for %s', async toolId => {
    const target = (value: string) => (toolId === 'bash' ? { command: value } : { path: value })
    const check = (input: string, policy: { mode: 'allow'; allow?: string[]; deny?: string[] }) =>
      enforceToolGovernance(invocation({ toolId, input: target(input), permissions: { [toolId]: policy } }))
    await expect(check('docs/deep/file.txt', { mode: 'allow', deny: ['docs/**'] })).rejects.toBeInstanceOf(
      PermissionDeniedError,
    )
    await expect(check('docs/deep/file.txt', { mode: 'allow', allow: ['docs/**'] })).resolves.toBeUndefined()
    await expect(check('docs/deep/file.txt', { mode: 'allow', allow: ['docs/*'] })).rejects.toBeInstanceOf(
      PermissionDeniedError,
    )
    await expect(check('docs/file.txt', { mode: 'allow', allow: ['docs/*'] })).resolves.toBeUndefined()
    await expect(
      check('docs/file.txt', { mode: 'allow', allow: ['docs/**'], deny: ['docs/*'] }),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
    const literal = 'docs/a[1].txt?(x)+$^{}|\\'
    await expect(check(literal, { mode: 'allow', deny: [literal] })).rejects.toBeInstanceOf(PermissionDeniedError)
    await expect(check('docs/a1.txt', { mode: 'allow', deny: [literal] })).resolves.toBeUndefined()
  })

  it('suppresses all approval demands when a deny contributes and audits matched decisions in order', async () => {
    const records: { effect: string; enforced: boolean }[] = []
    await expect(
      enforceToolGovernance(
        invocation({
          permissions: { bash: 'require_approval' },
          governance: {
            policies: [
              {
                id: 'policy',
                evaluate: () => [
                  { effect: 'require_approval', ruleId: 'approval' },
                  { effect: 'deny', ruleId: 'one' },
                  { effect: 'deny', ruleId: 'two' },
                ],
              },
            ],
            audit: {
              record: async record => {
                records.push(record)
              },
            },
          },
        }),
      ),
    ).rejects.toBeInstanceOf(PolicyDeniedError)
    expect(records.map(({ effect, enforced }) => ({ effect, enforced }))).toEqual([
      { effect: 'require_approval', enforced: false },
      { effect: 'deny', enforced: true },
      { effect: 'deny', enforced: true },
    ])
  })

  it('gives exposure predicates fresh deadlines and child signals', async () => {
    vi.useFakeTimers()
    const parent = new AbortController()
    const deadlines: number[] = []
    const when = async ({ deadline, signal }: { deadline: number; signal: AbortSignal }) => {
      expect(signal).not.toBe(parent.signal)
      deadlines.push(deadline - Date.now())
      await new Promise(resolve => setTimeout(resolve, 20))
      return true
    }
    const run = applyToolExposure({
      ...invocation({ signal: parent.signal, decisionTimeoutMs: 30 }),
      tools: [{ name: 'bash' }],
      governance: {
        exposure: {
          rules: [
            { id: 'one', effect: 'expose', when },
            { id: 'two', effect: 'expose', when },
          ],
        },
      },
    }).then(
      value => value,
      (error: unknown) => error,
    )
    await vi.advanceTimersByTimeAsync(50)
    expect(await run).toEqual(['bash'])
    expect(deadlines).toEqual([30, 30])
  })

  it.each(['throw', 'timeout'] as const)(
    'classifies audit %s as audit_failed with the failing record evidence',
    async kind => {
      vi.useFakeTimers()
      let recordEvidence: DecisionEvidence | undefined
      const run = enforceToolGovernance(
        invocation({
          decisionTimeoutMs: 10,
          governance: {
            policies: [{ id: 'policy', evaluate: () => ({ effect: 'allow' }) }],
            audit: {
              record: async record => {
                recordEvidence = record.evidence
                if (kind === 'throw') throw new Error('SYNTHETIC_PRIVATE')
                await new Promise(() => {})
              },
            },
          },
        }),
      ).catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(20)
      expect(await run).toMatchObject({
        code: 'DECISION_EVALUATION_ERROR',
        meta: { evidence: recordEvidence, failureKind: 'audit_failed' },
      })
      expect(JSON.stringify(serializeError(await run))).not.toContain('SYNTHETIC_PRIVATE')
    },
  )

  it.each(['native', 'external', 'exposure', 'audit'] as const)(
    'preserves cancellation during the %s callback',
    async boundary => {
      const parent = new AbortController()
      const cancelled = new OperationCancelledError('Cancelled.', { scope: 'run' })
      let callbackSignal: AbortSignal | undefined
      const cancel = (signal: AbortSignal): Promise<never> => {
        callbackSignal = signal
        parent.abort(cancelled)
        return new Promise(() => {})
      }
      const config: GovernanceConfig =
        boundary === 'native'
          ? {
              policies: [
                {
                  kind: 'native',
                  id: 'policy',
                  rules: [{ id: 'rule', effect: 'allow', when: ctx => cancel(ctx.signal) }],
                },
              ],
            }
          : boundary === 'external'
            ? { policies: [{ id: 'policy', evaluate: ctx => cancel(ctx.signal) }] }
            : boundary === 'exposure'
              ? { exposure: { rules: [{ id: 'rule', effect: 'hide', when: ctx => cancel(ctx.signal) }] } }
              : {
                  policies: [{ id: 'policy', evaluate: () => ({ effect: 'allow' }) }],
                  audit: { record: (_record, ctx) => cancel(ctx.signal) },
                }
      const args = invocation({ signal: parent.signal, governance: config })
      await expect(
        boundary === 'exposure'
          ? applyToolExposure({ ...args, tools: [{ name: 'bash' }] })
          : enforceToolGovernance(args),
      ).rejects.toBe(cancelled)
      expect(callbackSignal?.aborted).toBe(true)
    },
  )

  it('retains permission approval when governance is disabled and skips policies/exposure', async () => {
    const evaluate = vi.fn()
    const when = vi.fn()
    const args = invocation({
      permissions: { bash: 'require_approval' },
      governance: {
        enabled: false,
        policies: [{ id: 'policy', evaluate }],
        exposure: { rules: [{ id: 'hidden', effect: 'hide', when }] },
      },
    })
    await expect(applyToolExposure({ ...args, tools: [{ name: 'bash' }] })).resolves.toEqual(['bash'])
    await expect(enforceToolGovernance(args)).resolves.toMatchObject({ decision: 'approval_required' })
    expect(evaluate).not.toHaveBeenCalled()
    expect(when).not.toHaveBeenCalled()
  })

  it('accepts static approval requirements without an immediate provider', () => {
    for (const governance of [
      undefined,
      { mode: 'shadow' as const, policies: [{ id: 'policy', evaluate: () => ({ effect: 'allow' as const }) }] },
    ]) {
      const builder = defineHarness()
        .sandbox(inMemorySandbox())
        .models({ fake: { provider: new FakeModelProvider(), model: 'fake', capabilities: ['object'] } })
        .agent('answer', { model: 'fake', instructions: 'Answer.', permissions: { bash: 'require_approval' } })
      expect(() => (governance ? builder.governance(governance) : builder).build()).not.toThrow()
    }
    expect(() =>
      buildGovernance({
        policies: [{ kind: 'native', id: 'native', rules: [{ id: 'approval', effect: 'require_approval' }] }],
      }),
    ).not.toThrow()
  })

  it.each([
    null,
    false,
    [{ effect: 'allow' }, null],
    { effect: 'allow', metadata: {} },
    { effect: 'allow', ruleId: 'default' },
    { effect: 'allow', reasonCode: 'Private prose' },
  ])('fails closed on an invalid adapter result %#', async result => {
    await expect(
      enforceToolGovernance(
        invocation({ governance: { policies: [{ id: 'adapter', evaluate: () => result as never }] } }),
      ),
    ).rejects.toMatchObject({
      code: 'DECISION_EVALUATION_ERROR',
      meta: { failureKind: 'invalid_result', evidence: { decisionId: expectedId('adapter', 0) } },
    })
  })

  it.each([
    null,
    false,
    [],
    { approval: {}, policies: [] },
    { approval: { request: true } },
    { audit: { record: true }, approval: { request: async () => ({ decision: 'approved' }) } },
    { enabled: 'true' },
    { mode: 'nonsense' },
    { defaultEffect: 'nonsense' },
    { policies: {} },
    { policies: [null] },
    { policies: [{ id: 'adapter', evaluate: () => undefined, message: 'obsolete' }] },
    { policies: [{ id: 'adapter', evaluate: () => undefined }], unknown: true },
    ...['', 'bad\nidentifier', 'x'.repeat(129), 'governance.default', 'governance.exposure'].map(id => ({
      policies: [{ id, evaluate: () => undefined }],
    })),
    ...['', 'bad\nversion', 'x'.repeat(129)].map(version => ({
      policies: [{ id: 'adapter', version, evaluate: () => undefined }],
    })),
    { policies: [{ kind: 'native', id: 'native', rules: [{ id: 'default', effect: 'allow' }] }] },
    { policies: [{ kind: 'native', id: 'native', rules: [{ id: 'rule', effect: 'invalid' }] }] },
    { policies: [{ kind: 'native', id: 'native', rules: [{ id: 'rule', effect: 'allow', when: true }] }] },
    { policies: [{ kind: 'native', id: 'native', rules: [{ id: 'rule', effect: 'allow', metadata: {} }] }] },
    { policies: [{ kind: 'native', id: 'native', rules: [] }] },
    { exposure: { id: '', rules: [{ id: 'rule', effect: 'hide' }] } },
    { exposure: { rules: [{ id: 'default', effect: 'hide' }] } },
    {
      policies: [
        { id: 'duplicate', evaluate: () => undefined },
        { id: 'duplicate', evaluate: () => undefined },
      ],
    },
    {
      policies: [
        {
          kind: 'native',
          id: 'native',
          rules: [
            { id: 'duplicate', effect: 'allow' },
            { id: 'duplicate', effect: 'deny' },
          ],
        },
      ],
    },
    {
      exposure: {
        rules: [
          { id: 'duplicate', effect: 'hide' },
          { id: 'duplicate', effect: 'expose' },
        ],
      },
    },
  ])('rejects malformed or reserved governance configuration %#', config => {
    expect(() => buildGovernance(config)).toThrow(HarnessConfigError)
  })

  it('allows bounded Unicode configuration IDs', async () => {
    const harness = buildGovernance({
      policies: [{ id: '🙂'.repeat(128), version: 'Version one', evaluate: () => ({ effect: 'allow' }) }],
    })
    await harness.shutdown()
  })

  it.each(['permission', 'policy'] as const)('projects validated evidence for recoverable %s denial', async kind => {
      const governance: GovernanceConfig =
        kind === 'policy'
          ? { policies: [{ id: 'policy', evaluate: () => ({ effect: 'deny', reasonCode: 'restricted' }) }] }
        : {}
      const result = await enforceToolGovernance(
        invocation({
          input: { command: 'SYNTHETIC_PRIVATE' },
          metadata: { private: 'SYNTHETIC_PRIVATE' },
          governance,
        ...(kind === 'permission' ? { permissions: { bash: 'deny' } } : {}),
        }),
      ).catch((error: unknown) => error)
      const serialized = serializeError(result)
      expect(serialized.code).toBe(
        kind === 'permission' || kind === 'permission_rejected' ? 'PERMISSION_DENIED' : 'POLICY_DENIED',
      )
      expect(serialized.meta).toMatchObject({
        evidence: {
          decisionId: expect.stringMatching(/^decision_[a-f0-9]{64}$/),
        phase: kind === 'permission' ? 'permission' : 'policy',
        },
      })
      expect(JSON.stringify(serialized)).not.toContain('SYNTHETIC_PRIVATE')
      expect(Object.keys(serialized.meta ?? {})).toEqual(
        serialized.code === 'PERMISSION_DENIED' ? ['evidence'] : ['evidence', 'reason'],
      )
  })

  it('rejects unsafe error-constructor input and retains fixed messages', () => {
    const safe = evidence()
    expect(new PermissionDeniedError(safe).message).toBe('Permission denied.')
    expect(new PolicyDeniedError(safe, 'policy_deny').message).toBe('Tool call denied by governance policy.')
    expect(() => new PermissionDeniedError({ ...safe, input: 'SYNTHETIC_PRIVATE' } as never)).toThrow(
      HarnessConfigError,
    )
    expect(() => new PolicyDeniedError(safe, 'SYNTHETIC_PRIVATE' as never)).toThrow(HarnessConfigError)
  })
})
