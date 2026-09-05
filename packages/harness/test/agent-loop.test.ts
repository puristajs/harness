import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { defineAgent } from '../src/definitions/agent.js'
import type { AgentPipelineEvent } from '../src/definitions/execution-events.js'
import { resolveHarnessExecutionDefaults } from '../src/runtime/execution-defaults.js'
import { executeStandardAgent } from '../src/agents/standard-loop.js'
import { AgentLoopBudgetError, DecisionBlockedError, DecisionEvaluationError, OperationCancelledError, OperationTimeoutError, SandboxPermissionDeniedError, ValidationError } from '../src/errors/index.js'
import { executePreparedAgentToolBatch, prepareAgentToolBatch, resumePreparedAgentToolBatch } from '../src/agents/agent-tool-pipeline.js'
import { createAgentExecutableBinding } from '../src/tools/bindings.js'
import { createHarnessChildTargetInterruption } from '../src/runtime/steps.js'
import { defineTool } from '../src/definitions/tool.js'
import { agentGuardrailsBinding } from '../src/agents/guardrails.js'
import { getDefinitionIdentity } from '../src/definitions/identity.js'
import { freezeAcceptedModelTurnCursor, freezeSuspendedAgentTurnState } from '../src/approvals/prepared-tool-checkpoint.js'
import { createModelRegistry } from '../src/models/registry.js'

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }

afterEach(() => vi.useRealTimers())

function baseOptions(agent: ReturnType<typeof defineAgent>, model: object, mode: 'run' | 'stream') {
	const events: AgentPipelineEvent[] = []
	const history: import('../src/ports/model-provider.js').ModelMessage[] = []
	const invocation = {
		harnessName: 'testHarness', sessionId: 'session1', runId: 'run1', rootRunId: 'run1',
		invocationId: 'run1', agentId: agent.id, signal: new AbortController().signal,
		metadata: Object.freeze({}),
	}
	const models = Object.freeze({ primary: model as never })
	const toolContext = {
		...invocation, depth: 0, remainingDepth: 1,
		logger: {}, metrics: {}, telemetry: {}, memory: {}, sandbox: {}, targetDispatcher: {}, relayChildEvent: async () => {},
		checkpointStep: async (_id: string, work: () => Promise<unknown>) => work(),
	} as never
	const interceptorRuntime = {
		history: Object.freeze({ list: async () => history }), models,
		logger: toolContext.logger, metrics: toolContext.metrics, telemetry: toolContext.telemetry, memory: toolContext.memory,
	} as never
	return {
		options: {
			agent,
			mode,
			input: 'hello',
			history,
			model: model as never,
			modelAlias: 'primary',
			bindings: Object.freeze({}),
			skills: Object.freeze({}),
			defaults: resolveHarnessExecutionDefaults(),
			invocation,
			interceptorRuntime,
			toolContext,
			sink: { emit: async event => { events.push(event) } },
		},
		events,
	}
}

function attachToolRuntime(run: ReturnType<typeof baseOptions>, overrides: Record<string, unknown> = {}) {
	const interceptorFields = Object.fromEntries(Object.entries(overrides).filter(([key]) =>
		['history', 'models', 'memory', 'metrics', 'logger', 'telemetry'].includes(key)))
	const bindingFields = Object.fromEntries(Object.entries(overrides).filter(([key]) => !['history', 'models'].includes(key)))
	;(run.options as any).interceptorRuntime = { ...run.options.interceptorRuntime, ...interceptorFields }
	;(run.options as any).toolContext = { ...run.options.toolContext, ...bindingFields }
}

function directInterceptorRuntime() {
	return {
		history: Object.freeze({ list: async () => [] }), models: Object.freeze({ primary: Object.freeze({}) }),
		memory: Object.freeze({}), metrics: Object.freeze({}), logger: Object.freeze({}), telemetry: Object.freeze({}),
	} as never
}

describe('v4 standard agent loop', () => {
	it('applies the effective context projection only to model-visible tool results', async () => {
		let providerMessages: readonly import('../src/ports/model-provider.js').ModelMessage[] = []
		const agent = defineAgent('projectedAgent', { instructions: 'Answer.' })
		const run = baseOptions(agent, { async text(request: { messages: readonly import('../src/ports/model-provider.js').ModelMessage[] }) {
			providerMessages = request.messages
			return { content: 'done', usage, finishReason: 'stop' as const }
		} }, 'run')
		const original = 'abcdefghijklmnopqrstuvwxyz'.repeat(4)
		run.options.history.push({ role: 'assistant', content: 'calling' }, { role: 'tool', toolCallId: 'call-1', content: original })
		;(run.options as typeof run.options & { contextProjection: import('../src/context-projection.js').ContextProjectionPolicy }).contextProjection = {
			toolResultPruner: { maxBytes: 40, headBytes: 4, tailBytes: 4, marker: '...' },
		}

		await expect(executeStandardAgent(run.options)).resolves.toMatchObject({ output: 'done' })
		const projected = providerMessages.find(message => message.role === 'tool')
		expect(projected?.content).not.toBe(original)
		expect(Buffer.byteLength(projected?.content ?? '', 'utf8')).toBeLessThanOrEqual(40)
		expect(run.options.history.at(-1)?.content).toBe(original)
	})

	it('returns only the current logical conversation turn for persistence', async () => {
		const agent = defineAgent('conversationProjectionAgent', { instructions: 'Application instructions.' })
		const run = baseOptions(agent, { async text() { return { content: 'answer', usage, finishReason: 'stop' as const } } }, 'run')
		run.options.history.push({ role: 'user', content: 'old question' }, { role: 'assistant', content: 'old answer' })
		;(run.options as any).skills = { reporting: { manifest: { name: 'reporting', description: 'Report facts.' } } }

		const result = await executeStandardAgent(run.options)

		expect(result.conversationMessages).toEqual([
			{ role: 'user', content: 'hello' },
			{ role: 'assistant', content: 'answer' },
		])
		expect(Object.isFrozen(result.conversationMessages)).toBe(true)
	})

	it.each(['after_model', 'continue_turn'] as const)('resumes an accepted model cursor at the %s fence without repeating provider I/O', async phase => {
		let providerCalls = 0
		let afterModelCalls = 0
		let modelCompleted = 0
		const phases: string[] = []
		const guardrails = { [agentGuardrailsBinding]: { id: 'cursorGuard', afterModel() { afterModelCalls += 1; return { decision: 'allow' as const } } } }
		const agent = defineAgent('cursorAgent', { instructions: 'Answer.', guardrails: guardrails as never })
		const run = baseOptions(agent, { async text() { providerCalls += 1; return { content: 'unexpected', usage, finishReason: 'stop' as const } } }, 'run')
		const cursor = freezeAcceptedModelTurnCursor({ schemaVersion: 1, kind: 'accepted_model_turn', phase,
			rootRunId: 'run1', agentRunId: 'run1', sessionId: 'session1', agentId: agent.id, invocationId: 'run1',
			step: 1, modelAlias: 'primary', input: 'hello', mode: 'run', operation: 'text',
			request: { messages: [{ role: 'system', content: 'Answer.' }, { role: 'user', content: 'hello' }], tools: [] },
			response: { content: 'accepted', toolCalls: [], usage, finishReason: 'stop' }, agentStarted: true })
		;(run.options as any).onModelCompleted = async () => { modelCompleted += 1 }
		;(run.options as any).resume = { state: cursor, onAcceptedModelTurn: async (state: { phase: string }) => { phases.push(state.phase) } }

		await expect(executeStandardAgent(run.options)).resolves.toMatchObject({ output: 'accepted' })
		expect(providerCalls).toBe(0)
		expect(modelCompleted).toBe(phase === 'after_model' ? 1 : 0)
		expect(afterModelCalls).toBe(phase === 'after_model' ? 1 : 0)
		expect(phases).toEqual(phase === 'after_model' ? ['continue_turn'] : [])
	})

	it.each([
		{ operation: 'text', mode: 'run', structured: false },
		{ operation: 'object', mode: 'run', structured: true },
		{ operation: 'textStream', mode: 'stream', structured: false },
		{ operation: 'objectStream', mode: 'stream', structured: true },
	] as const)('passes and persists the same effective call for $operation', async ({ operation, mode, structured }) => {
		let providerCall: unknown
		let beforeModelCall: unknown
		let afterModelCall: unknown
		const guardrails = { [agentGuardrailsBinding]: { id: `effective${operation}Guard`,
			beforeModel(context: { request: { call?: unknown } }) { beforeModelCall = context.request.call; return { decision: 'allow' as const } },
			afterModel(context: { request: { call?: unknown } }) { afterModelCall = context.request.call; return { decision: 'allow' as const } },
		} }
		const provider = {
			id: 'effective-call-provider', genAiSystem: 'test',
			async text(request: { call?: unknown }) { providerCall = request.call; return { content: 'done', usage, finishReason: 'stop' as const } },
			async object(request: { call?: unknown }) { providerCall = request.call; return { object: { answer: 'done' }, usage, finishReason: 'stop' as const } },
			textStream(request: { call?: unknown }) { providerCall = request.call; return (async function* () {
				yield { kind: 'delta' as const, text: 'done' }
				yield { kind: 'finish' as const, usage, finishReason: 'stop' as const }
			})() },
			objectStream(request: { call?: unknown }) { providerCall = request.call; return (async function* () {
				yield { kind: 'partial' as const, partial: { answer: 'done' } }
				yield { kind: 'finish' as const, object: { answer: 'done' }, usage, finishReason: 'stop' as const }
			})() },
		}
		const model = createModelRegistry({ primary: { provider, model: 'test-model',
			capabilities: ['text', 'object', 'text_stream', 'object_stream'] as const,
			providerOptions: { aliasOnly: true }, defaults: { temperature: 0.2, maxTokens: 64,
				providerOptions: { defaultOnly: true }, retry: false } } }).primary!
		const agent = structured
			? defineAgent(`effective${operation}`, { instructions: 'Answer.', output: z.object({ answer: z.string() }), guardrails: guardrails as never })
			: defineAgent(`effective${operation}`, { instructions: 'Answer.', guardrails: guardrails as never })
		const run = baseOptions(agent, model, mode)
		const accepted: Array<ReturnType<typeof freezeAcceptedModelTurnCursor>> = []
		const state = freezeSuspendedAgentTurnState({ rootRunId: 'run1', agentRunId: 'run1', sessionId: 'session1',
			agentId: agent.id, invocationId: 'run1', step: 1, modelAlias: 'primary', input: 'hello',
			messages: [{ role: 'system', content: 'Answer.' }, { role: 'user', content: 'hello' }], entries: [], agentStarted: true })
		;(run.options as any).resume = { state, onAcceptedModelTurn: async (cursor: ReturnType<typeof freezeAcceptedModelTurnCursor>) => { accepted.push(cursor) } }

		await expect(executeStandardAgent(run.options)).resolves.toMatchObject({ output: structured ? { answer: 'done' } : 'done' })
		const expectedCall = { temperature: 0.2, maxTokens: 64, retry: false,
			providerOptions: { aliasOnly: true, defaultOnly: true } }
		expect(providerCall).toEqual(expectedCall)
		expect(beforeModelCall).toEqual(expectedCall)
		expect(afterModelCall).toEqual(expectedCall)
		expect(accepted[0]?.request.call).toEqual(expectedCall)
		expect(accepted[1]?.request.call).toEqual(expectedCall)
		expect(accepted[0]?.request.call).not.toBe(providerCall)
		expect(Object.isFrozen(providerCall)).toBe(true)
		expect(Object.isFrozen((providerCall as { providerOptions: object }).providerOptions)).toBe(true)
		expect(Object.isFrozen(accepted[0]?.request.call)).toBe(true)
		expect(accepted[0]?.operation).toBe(operation)
		expect('schema' in accepted[0]!.request).toBe(structured)
	})

	it('rejects non-JSON effective model call options before provider I/O', async () => {
		let providerCalls = 0
		const provider = { id: 'invalid-call-provider', genAiSystem: 'test', async text() {
			providerCalls += 1
			return { content: 'unexpected', usage, finishReason: 'stop' as const }
		} }
		const model = createModelRegistry({ primary: { provider, model: 'test-model', capabilities: ['text'] as const,
			defaults: { providerOptions: { invalid: new Date() } } } }).primary!
		const agent = defineAgent('invalidEffectiveCall', { instructions: 'Answer.' })
		const run = baseOptions(agent, model, 'run')

		await expect(executeStandardAgent(run.options)).rejects.toMatchObject({
			code: 'VALIDATION_ERROR', meta: { where: 'model_request', issues: { reason: 'non_json_model_call_options' } },
		})
		expect(providerCalls).toBe(0)
	})

	it('reuses the persisted effective call in the resumed afterModel view without resolving the current alias', async () => {
		let providerCalls = 0
		let observedCall: unknown
		const guardrails = { [agentGuardrailsBinding]: { id: 'persistedCallGuard', afterModel(context: { request: { call?: unknown } }) {
			observedCall = context.request.call
			return { decision: 'allow' as const }
		} } }
		const agent = defineAgent('persistedCallAgent', { instructions: 'Answer.', guardrails: guardrails as never })
		const provider = { id: 'changed-alias-provider', genAiSystem: 'test', async text() {
			providerCalls += 1
			return { content: 'unexpected', usage, finishReason: 'stop' as const }
		} }
		const currentModel = createModelRegistry({ primary: { provider, model: 'changed-model', capabilities: ['text'] as const,
			defaults: { providerOptions: { invalidIfRecomputed: new Date() } } } }).primary!
		const run = baseOptions(agent, currentModel, 'run')
		const persistedCall = { temperature: 0.7, providerOptions: { deployment: 'old' } }
		const cursor = freezeAcceptedModelTurnCursor({ schemaVersion: 1, kind: 'accepted_model_turn', phase: 'after_model',
			rootRunId: 'run1', agentRunId: 'run1', sessionId: 'session1', agentId: agent.id, invocationId: 'run1',
			step: 1, modelAlias: 'primary', input: 'hello', mode: 'run', operation: 'text',
			request: { messages: [{ role: 'system', content: 'Answer.' }, { role: 'user', content: 'hello' }], tools: [], call: persistedCall },
			response: { content: 'accepted', toolCalls: [], usage, finishReason: 'stop' }, agentStarted: true })
		;(run.options as any).resume = { state: cursor }

		await expect(executeStandardAgent(run.options)).resolves.toMatchObject({ output: 'accepted' })
		expect(providerCalls).toBe(0)
		expect(observedCall).toEqual(persistedCall)
		expect(Object.isFrozen(observedCall)).toBe(true)
		expect(Object.isFrozen((observedCall as { providerOptions: object }).providerOptions)).toBe(true)
	})

	it('does not recompute tool exposure when resuming an accepted model cursor', async () => {
		let exposureCalls = 0
		let providerCalls = 0
		const tool = defineTool('cursorVisible', { description: 'Visible tool.', input: z.string(), output: z.string(), async handler(_context, value) { return value } })
		const agent = defineAgent('cursorExposureAgent', { instructions: 'Answer.', tools: [tool], governance: ({ exposureRule }) => ({
			exposure: { rules: [exposureRule({ id: 'countExposure', tools: [tool.id], effect: 'expose', when: () => {
				exposureCalls += 1
				return true
			} })] },
		}) })
		const binding = createAgentExecutableBinding({ id: tool.id, description: tool.description, input: tool.input, output: tool.output,
			implementationKind: 'portable', definitionIdentity: getDefinitionIdentity(tool)!, digestDefinition: ['tool', tool.id],
			mcpOwner: null, remoteMcpName: null, outputValidation: 'required', async invokeValidated() { return 'unused' } })
		const run = baseOptions(agent, { async text() { providerCalls += 1; return { content: 'unexpected', usage, finishReason: 'stop' as const } } }, 'run')
		;(run.options as any).bindings = { [tool.id]: binding }
		const cursor = freezeAcceptedModelTurnCursor({ schemaVersion: 1, kind: 'accepted_model_turn', phase: 'continue_turn',
			rootRunId: 'run1', agentRunId: 'run1', sessionId: 'session1', agentId: agent.id, invocationId: 'run1',
			step: 1, modelAlias: 'primary', input: 'hello', mode: 'run', operation: 'text',
			request: { messages: [{ role: 'system', content: 'Answer.' }, { role: 'user', content: 'hello' }],
				tools: [{ name: tool.id, description: tool.description!, parameters: { type: 'string' } }] },
			response: { content: 'accepted', toolCalls: [], usage, finishReason: 'stop' }, agentStarted: true })
		;(run.options as any).resume = { state: cursor }

		await expect(executeStandardAgent(run.options)).resolves.toMatchObject({ output: 'accepted' })
		expect(exposureCalls).toBe(0)
		expect(providerCalls).toBe(0)
		expect(run.events.some(event => event.type === 'policy.exposure')).toBe(false)
	})

	it('rejects malformed accepted-model cursor request and response projections', () => {
		const valid = { schemaVersion: 1, kind: 'accepted_model_turn', phase: 'after_model', rootRunId: 'run1', agentRunId: 'run1',
			sessionId: 'session1', agentId: 'cursorAgent', invocationId: 'run1', step: 1, modelAlias: 'primary', input: 'hello',
			mode: 'run', operation: 'text', request: { messages: [{ role: 'user', content: 'hello' }], tools: [] },
			response: { content: 'accepted', toolCalls: [], usage, finishReason: 'stop' }, agentStarted: true } as const
		for (const malformed of [
			{ ...valid, unknown: true },
			{ ...valid, request: { ...valid.request, unknown: true } },
			{ ...valid, request: { ...valid.request, call: { providerOptions: { date: new Date() } } } },
			{ ...valid, request: { ...valid.request, call: { retry: { unknown: true } } } },
			{ ...valid, request: { ...valid.request, schema: {} } },
			{ ...valid, mode: 'stream', operation: 'text' },
			{ ...valid, mode: 'stream', operation: 'textStream' },
			{ ...valid, operation: 'object', response: { object: 'accepted', toolCalls: [], usage, finishReason: 'stop' } },
			{ ...valid, request: { ...valid.request, messages: [{ role: 'assistant', content: '', providerContinuation: { providerId: 'test', items: [] } }] } },
			{ ...valid, response: { ...valid.response, raw: { secret: true } } },
			{ ...valid, response: { ...valid.response, object: 'opposite' } },
			{ ...valid, response: { ...valid.response, toolCalls: [{ id: 'call', name: 'tool', arguments: 'ok', extra: true }] } },
			{ ...valid, providerContinuation: { providerId: 'test', items: [{ kind: 'tool_call', callId: 'missing-call' }] } },
		]) expect(() => freezeAcceptedModelTurnCursor(malformed as never)).toThrowError(expect.objectContaining({
			code: 'HARNESS_CONFIG_ERROR', meta: { reason: 'invalid_prepared_tool_checkpoint' },
		}))
	})

	it('rejects accepted-model cursor correlation drift before provider I/O', async () => {
		let providerCalls = 0
		const agent = defineAgent('cursorCorrelationAgent', { instructions: 'Answer.' })
		const run = baseOptions(agent, { async text() { providerCalls += 1; return { content: 'unexpected', usage, finishReason: 'stop' as const } } }, 'run')
		const cursor = freezeAcceptedModelTurnCursor({ schemaVersion: 1, kind: 'accepted_model_turn', phase: 'continue_turn',
			rootRunId: 'different-run', agentRunId: 'run1', sessionId: 'session1', agentId: agent.id, invocationId: 'run1',
			step: 1, modelAlias: 'primary', input: 'hello', mode: 'run', operation: 'text',
			request: { messages: [{ role: 'user', content: 'hello' }], tools: [] },
			response: { content: 'accepted', toolCalls: [], usage, finishReason: 'stop' }, agentStarted: true })
		;(run.options as any).resume = { state: cursor }
		await expect(executeStandardAgent(run.options)).rejects.toMatchObject({ code: 'VALIDATION_ERROR',
			meta: { where: 'invoke_options', issues: { reason: 'prepared_agent_context_mismatch' } } })
		expect(providerCalls).toBe(0)
	})

	it('uses text for omitted output and object for every explicit output schema', async () => {
		let textCalls = 0
		let objectCalls = 0
		const model = {
			async text() { textCalls += 1; return { content: 'plain', usage, finishReason: 'stop' as const } },
			async object() { objectCalls += 1; return { object: 'structured', usage, finishReason: 'stop' as const } },
		}
		const textAgent = defineAgent('textAgent', { instructions: 'Answer.' })
		const structuredStringAgent = defineAgent('structuredStringAgent', {
			instructions: 'Answer.', output: z.string(),
		})

		const textRun = baseOptions(textAgent, model, 'run')
		const objectRun = baseOptions(structuredStringAgent, model, 'run')
		await expect(executeStandardAgent(textRun.options)).resolves.toMatchObject({ output: 'plain' })
		await expect(executeStandardAgent(objectRun.options)).resolves.toMatchObject({ output: 'structured' })
		expect({ textCalls, objectCalls }).toEqual({ textCalls: 1, objectCalls: 1 })
	})

	it('uses the real text stream, one id per turn, and returns only terminal-step content', async () => {
		const streamIds: string[] = []
		const model = {
			textStream(_request: unknown, _signal: AbortSignal, context: { streamId: string }) {
				streamIds.push(context.streamId)
				return (async function* () {
					yield { kind: 'delta' as const, text: 'hel' }
					yield { kind: 'delta' as const, text: 'lo' }
					yield { kind: 'finish' as const, usage, finishReason: 'stop' as const }
				})()
			},
		}
		const agent = defineAgent('streamAgent', { instructions: 'Answer.' })
		const run = baseOptions(agent, model, 'stream')
		const result = await executeStandardAgent(run.options)
		expect(result.output).toBe('hello')
		expect(streamIds).toHaveLength(1)
		expect(run.events.filter(event => event.type === 'output.text.delta')).toEqual([
			expect.objectContaining({ id: streamIds[0], delta: 'hel' }),
			expect.objectContaining({ id: streamIds[0], delta: 'lo' }),
		])
	})

	it('rejects a stream without exactly one terminal finish', async () => {
		const model = {
			textStream() { return (async function* () { yield { kind: 'delta' as const, text: 'partial' } })() },
		}
		const agent = defineAgent('brokenStreamAgent', { instructions: 'Answer.' })
		const run = baseOptions(agent, model, 'stream')
		await expect(executeStandardAgent(run.options)).rejects.toMatchObject({
			constructor: ValidationError,
			meta: { where: 'model_response' },
		})
	})

	it('streams structured snapshots and rejects unknown or duplicate stream events', async () => {
		const agent = defineAgent('objectStreamAgent', { instructions: 'Answer.', output: z.object({ answer: z.string() }) })
		const model = { objectStream() { return (async function* () {
			yield { kind: 'partial' as const, partial: { answer: 'dra' } }
			yield { kind: 'delta' as const, path: ['answer'], value: 'draft' }
			yield { kind: 'finish' as const, object: { answer: 'final' }, usage, finishReason: 'stop' as const }
		})() } }
		const run = baseOptions(agent, model, 'stream')
		await expect(executeStandardAgent(run.options)).resolves.toMatchObject({ output: { answer: 'final' } })
		expect(run.events.filter(event => event.type === 'output.object.snapshot')).toHaveLength(2)

		for (const chunks of [
			[{ kind: 'mystery' }],
			[{ kind: 'finish', object: { answer: 'x' }, usage, finishReason: 'stop' }, { kind: 'finish', object: { answer: 'x' }, usage, finishReason: 'stop' }],
		]) {
			const invalid = baseOptions(agent, { objectStream() { return (async function* () { for (const chunk of chunks) yield chunk })() } }, 'stream')
			await expect(executeStandardAgent(invalid.options)).rejects.toBeInstanceOf(ValidationError)
		}
	})

	it('places the protected Skill discovery block between instructions and user input', async () => {
		let messages: unknown
		const model = {
			async text(request: { messages: unknown }) {
				messages = request.messages
				return { content: 'ok', usage, finishReason: 'stop' as const }
			},
		}
		const knowledge = Object.freeze({ id: 'knowledge', manifest: Object.freeze({ name: 'knowledge', description: 'Search reviewed facts.', ignored: true }) })
		const analysis = Object.freeze({ id: 'analysis', manifest: Object.freeze({ name: 'Analysis', description: 'Analyze records.' }) })
		const agent = defineAgent('skilledAgent', { instructions: 'Application rules.', skills: [] as never })
		const run = baseOptions(agent, model, 'run')
		run.options.skills = Object.freeze({ knowledge, analysis }) as never
		await executeStandardAgent(run.options)
		expect(messages).toEqual([
			{ role: 'system', content: 'Application rules.' },
			{ role: 'system', content: expect.stringContaining('[{"name":"Analysis","description":"Analyze records."},{"name":"knowledge","description":"Search reviewed facts."}]') },
			{ role: 'user', content: 'hello' },
		])
	})

	it('applies agent-scoped exposure governance to the complete model-facing tool map', async () => {
		let tools: unknown
		const model = {
			async text(request: { tools: unknown }) {
				tools = request.tools
				return { content: 'ok', usage, finishReason: 'stop' as const }
			},
		}
		const hidden = defineTool('hidden', { description: 'Hidden.', input: z.string(), output: z.string(), async handler(_context, value) { return value } })
		const visible = defineTool('visible', { description: 'Visible.', input: z.string(), output: z.string(), async handler(_context, value) { return value } })
		const agent = defineAgent('governedAgent', { instructions: 'Answer.', tools: [hidden, visible], governance: ({ exposureRule }) => ({
			exposure: { rules: [exposureRule({ id: 'hide-private', tools: ['hidden'], effect: 'hide' })] },
		}) })
		const run = baseOptions(agent, model, 'run')
		;(run.options as any).bindings = {
			hidden: createAgentExecutableBinding({ id: hidden.id, description: hidden.description, input: hidden.input, output: hidden.output,
				implementationKind: 'portable', definitionIdentity: getDefinitionIdentity(hidden)!, digestDefinition: ['tool', hidden.id],
				mcpOwner: null, remoteMcpName: null, outputValidation: 'required', async invokeValidated() { return 'hidden' } }),
			visible: createAgentExecutableBinding({ id: visible.id, description: visible.description, input: visible.input, output: visible.output,
				implementationKind: 'portable', definitionIdentity: getDefinitionIdentity(visible)!, digestDefinition: ['tool', visible.id],
				mcpOwner: null, remoteMcpName: null, outputValidation: 'required', async invokeValidated() { return 'visible' } }),
		}
		await executeStandardAgent(run.options)
		expect(tools).toEqual([expect.objectContaining({ name: 'visible' })])
		expect(run.events).toContainEqual(expect.objectContaining({ type: 'policy.exposure', toolId: 'hidden', effect: 'hide', enforced: true }))
	})

	it('never resolves a malicious hidden tool call against the full binding map', async () => {
		let hiddenCalls = 0
		let railCalls = 0
		let turn = 0
		const hidden = defineTool('hiddenMalicious', { description: 'Hidden.', input: z.string(), output: z.string(), async handler() { return 'unused' } })
		const binding = createAgentExecutableBinding({ id: hidden.id, description: hidden.description, input: hidden.input, output: hidden.output,
			implementationKind: 'portable', definitionIdentity: getDefinitionIdentity(hidden)!, digestDefinition: ['tool', hidden.id], mcpOwner: null,
			remoteMcpName: null, outputValidation: 'required', async invokeValidated() { hiddenCalls += 1; return 'secret' } })
		const guardrails = { [agentGuardrailsBinding]: { id: 'hiddenCallGuard', beforeTool: () => { railCalls += 1; return { decision: 'allow' as const } } } }
		const agent = defineAgent('hiddenCallAgent', { instructions: 'Do not call hidden tools.', tools: [hidden], guardrails, governance: ({ exposureRule }) => ({
			exposure: { rules: [exposureRule({ id: 'hideHidden', tools: [hidden.id], effect: 'hide' })] },
		}) })
		const requests: Array<{ tools: readonly { name: string }[]; messages: readonly unknown[] }> = []
		const model = { async text(request: { tools: readonly { name: string }[]; messages: readonly unknown[] }) {
			requests.push(request)
			turn += 1
			return turn === 1
				? { content: '', toolCalls: [{ id: 'hidden-call', name: hidden.id, arguments: 'steal' }], usage, finishReason: 'tool_calls' as const }
				: { content: 'safe', usage, finishReason: 'stop' as const }
		} }
		const run = baseOptions(agent, model, 'run')
		;(run.options as any).bindings = { [hidden.id]: binding }
		attachToolRuntime(run)
		await expect(executeStandardAgent(run.options)).resolves.toMatchObject({ output: 'safe' })
		expect(requests[0]?.tools).toEqual([])
		expect(requests[1]?.messages.at(-1)).toMatchObject({ role: 'tool', content: expect.stringContaining('TOOL_NOT_FOUND') })
		expect(hiddenCalls).toBe(0)
		expect(railCalls).toBe(0)
	})

	it('buffers a real stream behind beforeOutput and emits one guarded terminal update', async () => {
		const model = { textStream() { return (async function* () {
			yield { kind: 'delta' as const, text: 'secret-' }
			yield { kind: 'delta' as const, text: 'draft' }
			yield { kind: 'finish' as const, usage, finishReason: 'stop' as const }
		})() } }
		const guardrails = { [agentGuardrailsBinding]: { id: 'outputGuard', beforeOutput: () => ({ decision: 'transform' as const, value: 'approved' }) } }
		const agent = defineAgent('guardedStream', { instructions: 'Answer.', guardrails })
		const run = baseOptions(agent, model, 'stream')
		await expect(executeStandardAgent(run.options)).resolves.toMatchObject({ output: 'approved' })
		expect(run.events.filter(event => event.type === 'output.text.delta')).toEqual([
			expect.objectContaining({ delta: 'approved' }),
		])
	})

	it('fails closed for malformed hooks and reparses beforeInput transforms', async () => {
		let modelCalls = 0
		const model = { async text() { modelCalls += 1; return { content: 'ok', usage, finishReason: 'stop' as const } } }
		for (const beforeInput of [
			() => ({ decision: 'unknown' }),
			() => ({ decision: 'allow', extra: true }),
			() => ({ decision: 'transform', value: 42 }),
		]) {
			const guardrails = { [agentGuardrailsBinding]: { id: 'strictInput', beforeInput } }
			const agent = defineAgent('strictInputAgent', { instructions: 'Answer.', guardrails: guardrails as never })
			const run = baseOptions(agent, model, 'run')
			await expect(executeStandardAgent(run.options)).rejects.toBeInstanceOf(DecisionEvaluationError)
		}
		expect(modelCalls).toBe(0)
	})

	it('routes every remaining interceptor phase through the strict closed parser', async () => {
		for (const phase of ['beforeModel', 'afterModel', 'beforeOutput'] as const) {
			const guardrails = { [agentGuardrailsBinding]: { id: `strict${phase}`, [phase]: () => ({ decision: 'allow', extra: true }) } }
			const agent = defineAgent(`strict${phase}`, { instructions: 'Answer.', guardrails: guardrails as never })
			const run = baseOptions(agent, { async text() { return { content: 'ok', usage, finishReason: 'stop' as const } } }, 'run')
			await expect(executeStandardAgent(run.options)).rejects.toBeInstanceOf(DecisionEvaluationError)
		}

		const tool = defineTool('strictTool', { description: 'Strict.', input: z.string(), output: z.string(), async handler() { return 'unused' } })
		const binding = createAgentExecutableBinding({ id: tool.id, description: tool.description, input: tool.input, output: tool.output,
			implementationKind: 'portable', definitionIdentity: getDefinitionIdentity(tool)!, digestDefinition: ['tool', tool.id], mcpOwner: null,
			remoteMcpName: null, outputValidation: 'required', async invokeValidated() { return 'ok' } })
		for (const phase of ['beforeTool', 'afterTool'] as const) {
			const guardrails = { [agentGuardrailsBinding]: { id: `strict${phase}`, [phase]: () => ({ decision: 'allow', extra: true }) } }
			const agent = defineAgent(`strict${phase}`, { instructions: 'Use a tool.', tools: [tool], guardrails: guardrails as never })
			const run = baseOptions(agent, { async text() { return { content: '', toolCalls: [{ id: `call-${phase}`, name: tool.id, arguments: 'input' }], usage, finishReason: 'tool_calls' as const } } }, 'run')
			;(run.options as any).bindings = { [tool.id]: binding }
			attachToolRuntime(run)
			await expect(executeStandardAgent(run.options)).rejects.toBeInstanceOf(DecisionEvaluationError)
		}
	})

	it('provides the complete public interceptor context in every phase', async () => {
		const contexts: Record<string, any[]> = Object.fromEntries(
			['beforeInput', 'beforeModel', 'afterModel', 'beforeTool', 'afterTool', 'beforeOutput'].map(phase => [phase, []]),
		)
		const interceptor = { id: 'completeContextInterceptor',
			beforeInput: (context: any) => { contexts.beforeInput!.push(context); return { decision: 'allow' as const } },
			beforeModel: (context: any) => { contexts.beforeModel!.push(context); return { decision: 'allow' as const } },
			afterModel: (context: any) => { contexts.afterModel!.push(context); return { decision: 'allow' as const } },
			beforeTool: (context: any) => { contexts.beforeTool!.push(context); return { decision: 'allow' as const } },
			afterTool: (context: any) => { contexts.afterTool!.push(context); return { decision: 'allow' as const } },
			beforeOutput: (context: any) => { contexts.beforeOutput!.push(context); return { decision: 'allow' as const } },
		}
		const tool = defineTool('contextTool', { description: 'Context.', input: z.string(), output: z.string(), async handler() { return 'unused' } })
		const binding = createAgentExecutableBinding({ id: tool.id, description: tool.description, input: tool.input, output: tool.output,
			implementationKind: 'portable', definitionIdentity: getDefinitionIdentity(tool)!, digestDefinition: ['tool', tool.id], mcpOwner: null,
			remoteMcpName: null, outputValidation: 'required', async invokeValidated() { return 'tool output' } })
		let turn = 0
		const primary = { async text() { turn += 1; return turn === 1
			? { content: '', toolCalls: [{ id: 'context-call', name: tool.id, arguments: 'input' }], usage, finishReason: 'tool_calls' as const }
			: { content: 'done', usage, finishReason: 'stop' as const } } }
		const agent = defineAgent('completeContextAgent', { instructions: 'Use.', tools: [tool],
			guardrails: { [agentGuardrailsBinding]: interceptor } })
		const run = baseOptions(agent, primary, 'run')
		const models = Object.freeze({ primary: primary as never, secondary: Object.freeze({}) as never })
		const memory = Object.freeze({ marker: 'memory' })
		const metrics = Object.freeze({ marker: 'metrics' })
		const logger = Object.freeze({ marker: 'logger' })
		const telemetry = Object.freeze({ marker: 'telemetry' })
		const history = Object.freeze({ list: async () => run.options.history })
		;(run.options as any).bindings = { [tool.id]: binding }
		attachToolRuntime(run, { models, memory, metrics, logger, telemetry, history })
		await expect(executeStandardAgent(run.options)).resolves.toMatchObject({ output: 'done' })

		for (const [phase, phaseContexts] of Object.entries(contexts)) {
			expect(phaseContexts.length, phase).toBeGreaterThan(0)
			const phaseKeys: Record<string, string[]> = {
				beforeInput: ['input'], beforeModel: ['request'], afterModel: ['request', 'response'],
				beforeTool: ['toolId', 'callId', 'input'], afterTool: ['toolId', 'callId', 'output'], beforeOutput: ['output'],
			}
			const commonKeys = ['agentInput', 'interceptorId', 'invocationId', 'step', 'model', 'agentId', 'runId', 'sessionId',
				'history', 'memory', 'metadata', 'metrics', 'models', 'signal', 'decision', 'logger', 'telemetry']
			for (const context of phaseContexts) {
				expect(context).toMatchObject({
					agentInput: 'hello', interceptorId: interceptor.id, invocationId: 'run1', agentId: agent.id,
					runId: 'run1', sessionId: 'session1', model: 'primary', metadata: run.options.invocation.metadata,
					models, memory, metrics, logger, telemetry, history,
					decision: { signal: expect.any(AbortSignal), deadline: expect.any(Number) },
				})
				expect(Object.keys(context).sort()).toEqual([...commonKeys, ...phaseKeys[phase]!].sort())
			}
		}
		expect(contexts.beforeInput).toHaveLength(1)
		expect(contexts.beforeModel).toHaveLength(2)
		expect(contexts.afterModel).toHaveLength(2)
		expect(contexts.beforeTool).toHaveLength(1)
		expect(contexts.afterTool).toHaveLength(1)
		expect(contexts.beforeOutput).toHaveLength(1)
	})

	it.each([
		['beforeInput', 'input'],
		['beforeModel', 'before_model'],
		['afterModel', 'after_model'],
		['beforeTool', 'tool_input'],
		['afterTool', 'tool_output'],
		['beforeOutput', 'output'],
	] as const)('uses interceptor identity and the correct evidence phase for %s blocks', async (hook, phase) => {
		const tool = defineTool(`blocked${hook}Tool`, { description: 'Block.', input: z.string(), output: z.string(), async handler() { return 'unused' } })
		const binding = createAgentExecutableBinding({ id: tool.id, description: tool.description, input: tool.input, output: tool.output,
			implementationKind: 'portable', definitionIdentity: getDefinitionIdentity(tool)!, digestDefinition: ['tool', tool.id], mcpOwner: null,
			remoteMcpName: null, outputValidation: 'required', async invokeValidated() { return 'tool output' } })
		const interceptorId = `blocked${hook}Interceptor`
		const agent = defineAgent(`blocked${hook}Agent`, { instructions: 'Block.', tools: [tool], guardrails: {
			[agentGuardrailsBinding]: { id: interceptorId, [hook]: () => ({ decision: 'block' as const, reasonCode: 'blocked_test' }) },
		} as never })
		const requiresTool = hook === 'beforeTool' || hook === 'afterTool'
		const run = baseOptions(agent, { async text() { return requiresTool
			? { content: '', toolCalls: [{ id: `blocked-${hook}-call`, name: tool.id, arguments: 'input' }], usage, finishReason: 'tool_calls' as const }
			: { content: 'done', usage, finishReason: 'stop' as const } } }, 'run')
		;(run.options as any).bindings = { [tool.id]: binding }
		const error = await executeStandardAgent(run.options).catch(value => value)
		expect(error).toMatchObject({ constructor: DecisionBlockedError })
		expect(error.meta).toMatchObject({ evidence: { source: { kind: 'interceptor', id: interceptorId }, phase, reasonCode: 'blocked_test' } })
	})

	it('freezes hook transcripts and permits only complete older interaction-group reordering', async () => {
		const tool = defineTool('transcriptTool', { description: 'Transcript.', input: z.string(), output: z.string(), async handler() { return 'unused' } })
		const binding = createAgentExecutableBinding({ id: tool.id, description: tool.description, input: tool.input, output: tool.output,
			implementationKind: 'portable', definitionIdentity: getDefinitionIdentity(tool)!, digestDefinition: ['tool', tool.id], mcpOwner: null,
			remoteMcpName: null, outputValidation: 'required', async invokeValidated(_context, input) { return input } })
		let frozen = true
		let mutationBlocked = false
		const guardrails = { [agentGuardrailsBinding]: { id: 'protectedTranscript',
			beforeModel: ({ request, step }: any) => {
				frozen &&= Object.isFrozen(request) && Object.isFrozen(request.messages) && Object.isFrozen(request.tools)
					&& (step < 2 || (Object.isFrozen(request.messages[2]) && Object.isFrozen(request.messages[2].toolCalls)
						&& Object.isFrozen(request.messages[2].toolCalls[0].arguments)))
				try { request.messages[0].content = 'mutated outside transform' } catch { mutationBlocked = true }
				if (step === 2) {
					const messages = JSON.parse(JSON.stringify(request.messages))
					messages[0].content = 'Edited system content is permitted.'
					messages[1].content = 'Edited user content is permitted.'
					return { decision: 'transform' as const, value: { messages } }
				}
				if (step === 4) {
					const messages = JSON.parse(JSON.stringify(request.messages))
					return { decision: 'transform' as const, value: { messages: [
						messages[0], messages[1], messages[4], messages[5], messages[2], messages[3], messages[6], messages[7],
					] } }
				}
				return { decision: 'allow' as const }
			},
			afterModel: ({ request, response }: any) => {
				frozen &&= Object.isFrozen(request) && Object.isFrozen(response)
					&& (response.providerContinuation === undefined || Object.isFrozen(response.providerContinuation))
				return { decision: 'allow' as const }
			},
		} }
		let turn = 0
		const model = { async text() {
			turn += 1
			if (turn < 4) {
				const callId = `protected-call-${turn}`
				return { content: '', toolCalls: [{ id: callId, name: tool.id, arguments: `input-${turn}` }],
					providerContinuation: { providerId: 'test', items: [{ kind: 'tool_call' as const, callId }] }, usage, finishReason: 'tool_calls' as const }
			}
			return { content: 'done', usage, finishReason: 'stop' as const }
		} }
		const agent = defineAgent('protectedTranscriptAgent', { instructions: 'Use tools.', tools: [tool], guardrails: guardrails as never })
		const run = baseOptions(agent, model, 'run')
		;(run.options as any).bindings = { [tool.id]: binding }
		attachToolRuntime(run)
		await expect(executeStandardAgent(run.options)).resolves.toMatchObject({ output: 'done' })
		expect({ frozen, mutationBlocked }).toEqual({ frozen: true, mutationBlocked: true })
	})

	it('rejects protected interaction injection, splitting, rewriting, duplicate ids, and continuation changes', async () => {
		const mutations: Array<(messages: any[]) => any[]> = [
			messages => messages.slice(0, 2),
			messages => [...messages.slice(0, 2), messages[3]],
			messages => { messages[2].toolCalls[0].arguments = 'rewritten'; return messages },
			messages => [...messages, messages[2], messages[3]],
			messages => { messages[2].providerContinuation.providerId = 'changed'; return messages },
			messages => [...messages, { role: 'assistant', content: '', toolCalls: [{ id: 'injected', name: 'transcriptGuardTool', arguments: null }] },
				{ role: 'tool', toolCallId: 'injected', content: '"injected"' }],
		]
		for (const [index, mutate] of mutations.entries()) {
			const tool = defineTool(`transcriptGuardTool${index}`, { description: 'Transcript.', input: z.string(), output: z.string(), async handler() { return 'unused' } })
			const binding = createAgentExecutableBinding({ id: tool.id, description: tool.description, input: tool.input, output: tool.output,
				implementationKind: 'portable', definitionIdentity: getDefinitionIdentity(tool)!, digestDefinition: ['tool', tool.id], mcpOwner: null,
				remoteMcpName: null, outputValidation: 'required', async invokeValidated() { return 'result' } })
			const guardrails = { [agentGuardrailsBinding]: { id: `transcriptGuard${index}`, beforeModel: ({ request, step }: any) => step === 2
				? { decision: 'transform' as const, value: { messages: mutate(JSON.parse(JSON.stringify(request.messages))) } }
				: { decision: 'allow' as const } } }
			let turn = 0
			const callId = `guard-call-${index}`
			const model = { async text() { turn += 1; return turn === 1
				? { content: '', toolCalls: [{ id: callId, name: tool.id, arguments: 'input' }],
					providerContinuation: { providerId: 'test', items: [{ kind: 'tool_call' as const, callId }] }, usage, finishReason: 'tool_calls' as const }
				: { content: 'unsafe', usage, finishReason: 'stop' as const } } }
			const agent = defineAgent(`transcriptGuardAgent${index}`, { instructions: 'Use tools.', tools: [tool], guardrails: guardrails as never })
			const run = baseOptions(agent, model, 'run')
			;(run.options as any).bindings = { [tool.id]: binding }
			attachToolRuntime(run)
			await expect(executeStandardAgent(run.options)).rejects.toMatchObject({
				constructor: DecisionEvaluationError, meta: { failureKind: 'invalid_transform' },
			})
		}
	})

	it('keeps standalone assistant content-part messages immutable across beforeModel transforms', async () => {
		const protectedAssistantMessage = { role: 'assistant' as const, content: [{ kind: 'text' as const, text: 'protected content part' }] }
		const unchangedGuardrails = { [agentGuardrailsBinding]: { id: 'unchangedParts', beforeModel: ({ request }: any) => ({
			decision: 'transform' as const, value: { messages: JSON.parse(JSON.stringify(request.messages)) },
		}) } }
		const unchangedAgent = defineAgent('unchangedPartsAgent', { instructions: 'Answer.', guardrails: unchangedGuardrails as never })
		const unchanged = baseOptions(unchangedAgent, { async text() { return { content: 'ok', usage, finishReason: 'stop' as const } } }, 'run')
		unchanged.options.history.push(protectedAssistantMessage)
		await expect(executeStandardAgent(unchanged.options)).resolves.toMatchObject({ output: 'ok' })

		let providerCalls = 0
		const changedGuardrails = { [agentGuardrailsBinding]: { id: 'changedParts', beforeModel: ({ request }: any) => {
			const messages = JSON.parse(JSON.stringify(request.messages))
			messages[1].content[0].text = 'rewritten content part'
			return { decision: 'transform' as const, value: { messages } }
		} } }
		const changedAgent = defineAgent('changedPartsAgent', { instructions: 'Answer.', guardrails: changedGuardrails as never })
		const changed = baseOptions(changedAgent, { async text() { providerCalls += 1; return { content: 'unsafe', usage, finishReason: 'stop' as const } } }, 'run')
		changed.options.history.push(protectedAssistantMessage)
		await expect(executeStandardAgent(changed.options)).rejects.toMatchObject({
			constructor: DecisionEvaluationError, meta: { failureKind: 'invalid_transform' },
		})
		expect(providerCalls).toBe(0)

		const swappedGuardrails = { [agentGuardrailsBinding]: { id: 'swappedParts', beforeModel: ({ request }: any) => {
			const messages = JSON.parse(JSON.stringify(request.messages))
			return { decision: 'transform' as const, value: { messages: [messages[0], messages[2], messages[1], messages[3]] } }
		} } }
		const swappedAgent = defineAgent('swappedPartsAgent', { instructions: 'Answer.', guardrails: swappedGuardrails as never })
		const swapped = baseOptions(swappedAgent, { async text() { providerCalls += 1; return { content: 'unsafe', usage, finishReason: 'stop' as const } } }, 'run')
		swapped.options.history.push({ role: 'assistant', content: 'editable plain assistant text' }, protectedAssistantMessage)
		await expect(executeStandardAgent(swapped.options)).rejects.toMatchObject({
			constructor: DecisionEvaluationError, meta: { failureKind: 'invalid_transform' },
		})
		expect(providerCalls).toBe(0)
	})

	it('rejects undeclared prompt media capabilities before provider I/O', async () => {
		let called = false
		const input = z.object({ image: z.string() })
		const agent = defineAgent('unsafePrompt', { instructions: 'Inspect.', input,
			prompt: (() => ({ role: 'user', content: [{ kind: 'image_url', url: 'https://example.invalid/image.png' }] })) as never })
		const run = baseOptions(agent, { async text() { called = true; return { content: 'no', usage, finishReason: 'stop' as const } } }, 'run')
		;(run.options as any).input = { image: 'x' }
		await expect(executeStandardAgent(run.options)).rejects.toMatchObject({ code: 'HARNESS_CONFIG_ERROR', meta: { reason: 'invalid_agent_prompt' } })
		expect(called).toBe(false)
	})

	it('races a non-cooperative provider and preserves cancellation identity', async () => {
		vi.useFakeTimers()
		const agent = defineAgent('timedAgent', { instructions: 'Answer.' })
		const timed = baseOptions(agent, { text: () => new Promise(() => {}) }, 'run')
		;(timed.options as any).defaults = resolveHarnessExecutionDefaults({ modelTimeoutMs: 5 })
		const timeoutRun = executeStandardAgent(timed.options).catch(error => error)
		await vi.advanceTimersByTimeAsync(10)
		await expect(timeoutRun).resolves.toBeInstanceOf(OperationTimeoutError)

		const cancelled = new AbortController()
		cancelled.abort('stop')
		const cancelledRun = baseOptions(agent, { text: () => new Promise(() => {}) }, 'run')
		;(cancelledRun.options as any).invocation = { ...cancelledRun.options.invocation, signal: cancelled.signal }
		await expect(executeStandardAgent(cancelledRun.options)).rejects.toBeInstanceOf(OperationCancelledError)
	})

	it('keeps transformed wire arguments separate, validates output once, and retains only the tool envelope/results', async () => {
		let outputValidations = 0
		let observed: unknown
		const toolAgentInputs: unknown[] = []
		const tool = defineTool('lookup', { description: 'Lookup.', input: z.object({ value: z.string() }).transform(value => ({ value: value.value.toUpperCase() })),
			output: z.string().transform(value => { outputValidations += 1; return value.toUpperCase() }), async handler() { return 'unused' } })
		const binding = createAgentExecutableBinding({ id: 'lookup', description: tool.description, input: tool.input, output: tool.output,
			implementationKind: 'portable', definitionIdentity: getDefinitionIdentity(tool)!, digestDefinition: ['tool', tool.id],
			mcpOwner: null, remoteMcpName: null, outputValidation: 'required', async invokeValidated(_context, input, wireInput) { observed = { input, wireInput }; return 'result' } })
		const requests: any[] = []
		const continuation = { providerId: 'test', items: [{ kind: 'tool_call' as const, callId: 'call-1' }] }
		const model = { async text(request: any) { requests.push(request); return requests.length === 1
			? { content: 'discard me', toolCalls: [{ id: 'call-1', name: 'lookup', arguments: { value: 'raw' } }], providerContinuation: continuation, usage, finishReason: 'tool_calls' as const }
			: { content: 'done', usage, finishReason: 'stop' as const } } }
		const guardrails = { [agentGuardrailsBinding]: { id: 'toolGuard',
			beforeInput: () => ({ decision: 'transform' as const, value: 'effective-agent-input' }),
			beforeTool: ({ input, agentInput }: any) => { toolAgentInputs.push(agentInput); return { decision: 'transform' as const, value: { value: `${input.value}-changed` } } },
			afterTool: ({ agentInput }: any) => { toolAgentInputs.push(agentInput); return { decision: 'allow' as const } },
		} }
		const agent = defineAgent('toolAgent', { instructions: 'Use tools.', tools: [tool], guardrails })
		const run = baseOptions(agent, model, 'run')
		;(run.options as any).bindings = { lookup: binding }
		attachToolRuntime(run, { trace: { traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01' } })
		const result = await executeStandardAgent(run.options)
		expect(observed).toEqual({ input: { value: 'RAW-CHANGED' }, wireInput: { value: 'raw-changed' } })
		expect(toolAgentInputs).toEqual(['effective-agent-input', 'effective-agent-input'])
		expect(outputValidations).toBe(1)
		expect(requests[1].messages.slice(-2)).toEqual([
			expect.objectContaining({ role: 'assistant', content: '', toolCalls: [expect.objectContaining({ arguments: { value: 'raw-changed' } })], providerContinuation: continuation }),
			{ role: 'tool', toolCallId: 'call-1', content: '"RESULT"' },
		])
		expect(JSON.stringify(result.messages)).not.toContain('providerContinuation')
		expect(JSON.stringify(result.messages)).not.toContain('discard me')
	})

	it('relays provisional output across a streamed tool turn and returns only the terminal turn', async () => {
		const tool = defineTool('lookupLive', { description: 'Lookup.', input: z.string(), output: z.string(), async handler() { return 'unused' } })
		const binding = createAgentExecutableBinding({ id: tool.id, description: tool.description, input: tool.input, output: tool.output,
			implementationKind: 'portable', definitionIdentity: getDefinitionIdentity(tool)!, digestDefinition: ['tool', tool.id], mcpOwner: null,
			remoteMcpName: null, outputValidation: 'required', async invokeValidated() { return 'result' } })
		let turn = 0
		const model = { textStream() { turn += 1; const current = turn; return (async function* () {
			yield { kind: 'delta' as const, text: current === 1 ? 'working' : 'final' }
			if (current === 1) yield { kind: 'tool_call' as const, call: { id: 'call-live', name: 'lookupLive', arguments: 'query' } }
			yield { kind: 'finish' as const, usage, finishReason: current === 1 ? 'tool_calls' as const : 'stop' as const }
		})() } }
		const agent = defineAgent('liveToolAgent', { instructions: 'Use tools.', tools: [tool] })
		const run = baseOptions(agent, model, 'stream')
		;(run.options as any).bindings = { lookupLive: binding }
		attachToolRuntime(run)
		const result = await executeStandardAgent(run.options)
		expect(result.output).toBe('final')
		expect(run.events.filter(event => event.type === 'output.text.delta').map(event => 'delta' in event ? event.delta : '')).toEqual(['working', 'final'])
		expect(JSON.stringify(result.messages)).not.toContain('working')
	})

	it('preflights the full batch and preserves branded child interruptions without tool failure events', async () => {
		const child = defineAgent('child', { instructions: 'Answer.' })
		const interruption = createHarnessChildTargetInterruption('child-invocation', {
			status: 'interrupted', runId: 'child-run', interrupt: { type: 'tool-approval', id: 'approval', revision: 'v1', requests: [] },
		})
		const binding = createAgentExecutableBinding({ id: 'delegate', description: 'Delegate.', input: z.string(), output: z.string(),
			implementationKind: 'subagent', definitionIdentity: getDefinitionIdentity(child)!, digestDefinition: ['agent', child.id],
			mcpOwner: null, remoteMcpName: null, outputValidation: 'already-validated-target', async invokeValidated() { throw interruption } })
		const events: AgentPipelineEvent[] = []
		const agent = defineAgent('parent', { instructions: 'Delegate.' })
		let suspended: unknown
		const options = { agent, calls: [{ id: 'call-1', name: 'delegate', arguments: 'question' }], bindings: { delegate: binding }, interceptorRuntime: directInterceptorRuntime(),
			invocation: { runId: 'parent-run', rootRunId: 'parent-run', sessionId: 's1', invocationId: 'parent-run', metadata: {}, signal: new AbortController().signal, telemetry: undefined } as never,
			step: 1, agentInput: 'question', toolTimeoutMs: 1000, decisionTimeoutMs: 1000, sink: { emit: async event => { events.push(event) } },
			remainingToolCalls: 1, remainingSubagentCalls: 1, maxToolCalls: 1, maxSubagentCalls: 1,
			maxParallelToolCalls: 1, maxParallelSubagents: 1,
			onChildInterruption: (entry: unknown) => { suspended = entry } } as const
		const prepared = await prepareAgentToolBatch(options)
		await expect(executePreparedAgentToolBatch(options, prepared)).rejects.toBe(interruption)
		expect(events.map(event => event.type)).toEqual(['tool.input.available', 'tool.started'])
		expect(suspended).toMatchObject({ state: 'suspended-child', childInvocationId: 'child-invocation', childRunId: 'child-run', toolStarted: true })
	})

	it.each(['onChildInterruption', 'onEntry'] as const)('does not let a throwing %s observer mask child interruption', async observer => {
		const child = defineAgent(`observerChild${observer}`, { instructions: 'Answer.' })
		const interruption = createHarnessChildTargetInterruption(`observer-${observer}`, {
			status: 'interrupted', runId: `child-${observer}`, interrupt: { type: 'tool-approval', id: 'approval', revision: 'v1', requests: [] },
		})
		const binding = createAgentExecutableBinding({ id: 'delegateObserver', description: 'Delegate.', input: z.string(), output: z.string(),
			implementationKind: 'subagent', definitionIdentity: getDefinitionIdentity(child)!, digestDefinition: ['agent', child.id],
			mcpOwner: null, remoteMcpName: null, outputValidation: 'already-validated-target', async invokeValidated() { throw interruption } })
		const events: AgentPipelineEvent[] = []
		const agent = defineAgent(`observerParent${observer}`, { instructions: 'Delegate.' })
		const options = { agent, agentInput: 'question', calls: [{ id: 'observer-call', name: 'delegateObserver', arguments: 'question' }],
			bindings: { delegateObserver: binding }, interceptorRuntime: directInterceptorRuntime(), invocation: { runId: 'observer-parent', rootRunId: 'observer-parent', sessionId: 'observer-session',
				invocationId: 'observer-parent', metadata: {}, signal: new AbortController().signal, telemetry: undefined } as never,
			step: 1, toolTimeoutMs: 1000, decisionTimeoutMs: 1000, sink: { emit: async event => { events.push(event) } },
			remainingToolCalls: 1, remainingSubagentCalls: 1, maxToolCalls: 1, maxSubagentCalls: 1,
			maxParallelToolCalls: 1, maxParallelSubagents: 1,
			[observer]: () => { throw new Error(`${observer} failed`) } } as const
		await expect(executePreparedAgentToolBatch(options, await prepareAgentToolBatch(options))).rejects.toBe(interruption)
		expect(events.map(event => event.type)).toEqual(['tool.input.available', 'tool.started'])
	})

	it('attaches the complete parent frame to a child interruption in the standard loop', async () => {
		const child = defineAgent('frameChild', { instructions: 'Answer.' })
		const interruption = createHarnessChildTargetInterruption('frame-child-invocation', {
			status: 'interrupted', runId: 'frame-child-run', interrupt: { type: 'tool-approval', id: 'approval', revision: 'v1', requests: [] },
		})
		const binding = createAgentExecutableBinding({ id: 'delegateFrame', description: 'Delegate.', input: z.string(), output: z.string(),
			implementationKind: 'subagent', definitionIdentity: getDefinitionIdentity(child)!, digestDefinition: ['agent', child.id], mcpOwner: null,
			remoteMcpName: null, outputValidation: 'already-validated-target', async invokeValidated() { throw interruption } })
		const parent = defineAgent('frameParent', { instructions: 'Delegate.' })
		const run = baseOptions(parent, { async text() { return { content: 'discard', toolCalls: [{ id: 'frame-call', name: 'delegateFrame', arguments: 'question' }],
			usage, finishReason: 'tool_calls' as const } } }, 'run')
		;(run.options as any).bindings = { delegateFrame: binding }
		attachToolRuntime(run)
		await expect(executeStandardAgent(run.options)).rejects.toBe(interruption)
		expect(interruption.preparedState).toMatchObject({ agentId: 'frameParent', entries: [expect.objectContaining({ state: 'suspended-child', childInvocationId: 'frame-child-invocation' })] })
		expect(run.events.filter(event => event.type === 'tool.finished')).toHaveLength(0)
	})

	it('resumes a suspended child through output completion without invoking or starting it twice', async () => {
		const child = defineAgent('resumeChild', { instructions: 'Answer.' })
		let invocations = 0
		let outputValidations = 0
		const output = z.string().transform(value => { outputValidations += 1; return value.toUpperCase() })
		const binding = createAgentExecutableBinding({ id: 'resumeDelegate', description: 'Delegate.', input: z.string(), output,
			implementationKind: 'subagent', definitionIdentity: getDefinitionIdentity(child)!, digestDefinition: ['agent', child.id],
			mcpOwner: null, remoteMcpName: null, outputValidation: 'already-validated-target', async invokeValidated() { invocations += 1; return 'unused' } })
		const events: AgentPipelineEvent[] = []
		const agent = defineAgent('resumeParent', { instructions: 'Delegate.' })
		const entry = Object.freeze({ state: 'suspended-child' as const, call: Object.freeze({ id: 'resume-call', name: 'resumeDelegate', arguments: 'question' }),
			input: 'question', bindingId: 'resumeDelegate', bindingContractDigest: binding.contractDigest, toolStarted: true as const,
			childInvocationId: 'child-invocation', childRunId: 'child-run' })
		const options = { agent, agentInput: 'question', calls: [entry.call], bindings: { resumeDelegate: binding }, interceptorRuntime: directInterceptorRuntime(),
			invocation: { runId: 'parent-run', rootRunId: 'parent-run', sessionId: 'session', invocationId: 'parent-run', depth: 0,
				remainingDepth: 1, metadata: {}, signal: new AbortController().signal } as never,
			step: 1, toolTimeoutMs: 1000, decisionTimeoutMs: 1000, sink: { emit: async event => { events.push(event) } },
			remainingToolCalls: 1, remainingSubagentCalls: 1, maxToolCalls: 1, maxSubagentCalls: 1,
			maxParallelToolCalls: 1, maxParallelSubagents: 1, resumeSuspendedChild: async () => 'DONE' } as const

		const result = await resumePreparedAgentToolBatch(options, [entry], [])
		expect(result[0]).toMatchObject({ entry: { state: 'completed', outcome: { status: 'completed', output: 'DONE' } }, message: { content: '"DONE"' } })
		expect(invocations).toBe(0)
		expect(outputValidations).toBe(0)
		expect(events.map(event => event.type)).toEqual(['tool.finished'])
	})

	it('records recoverable and denied preflight entries without aborting sibling calls', async () => {
		const bash = defineTool('bash', { description: 'Run.', input: z.object({ command: z.string() }), output: z.string(), async handler() { return 'unused' } })
		const lookup = defineTool('lookupInvalid', { description: 'Lookup.', input: z.object({ query: z.string() }), output: z.string(), async handler() { return 'unused' } })
		const binding = createAgentExecutableBinding({ id: bash.id, description: bash.description, input: bash.input, output: bash.output,
			implementationKind: 'portable', definitionIdentity: getDefinitionIdentity(bash)!, digestDefinition: ['tool', bash.id], mcpOwner: null,
			remoteMcpName: null, outputValidation: 'required', async invokeValidated() { return 'unused' } })
		const lookupBinding = createAgentExecutableBinding({ id: lookup.id, description: lookup.description, input: lookup.input, output: lookup.output,
			implementationKind: 'portable', definitionIdentity: getDefinitionIdentity(lookup)!, digestDefinition: ['tool', lookup.id], mcpOwner: null,
			remoteMcpName: null, outputValidation: 'required', async invokeValidated() { return 'unused' } })
		const guardrails = { [agentGuardrailsBinding]: { id: 'preflightTransform', beforeTool: ({ toolId }: { toolId: string }) => toolId === lookup.id
			? { decision: 'transform' as const, value: { query: 42 } }
			: { decision: 'allow' as const } } }
		const agent = defineAgent('preflightAgent', { instructions: 'Use tools.', tools: [bash, lookup], permissions: { bash: 'deny' }, guardrails: guardrails as never })
		const events: AgentPipelineEvent[] = []
		const options = { agent, agentInput: 'question', calls: [
			{ id: 'missing-call', name: 'missing', arguments: { raw: true } },
			{ id: 'invalid-call', name: lookup.id, arguments: { query: 'raw' } },
			{ id: 'provider-invalid-call', name: 'bash', arguments: { command: 42 } },
			{ id: 'denied-call', name: 'bash', arguments: { command: 'echo denied' } },
		], bindings: { bash: binding, [lookup.id]: lookupBinding }, interceptorRuntime: directInterceptorRuntime(), invocation: { runId: 'run', rootRunId: 'run', sessionId: 's', invocationId: 'run', depth: 0,
			remainingDepth: 1, metadata: {}, signal: new AbortController().signal, telemetry: undefined } as never,
			step: 1, toolTimeoutMs: 1000, decisionTimeoutMs: 1000, sink: { emit: async event => { events.push(event) } },
			remainingToolCalls: 4, remainingSubagentCalls: 1, maxToolCalls: 4, maxSubagentCalls: 1,
			maxParallelToolCalls: 4, maxParallelSubagents: 1 } as const
		const prepared = await prepareAgentToolBatch(options)
		expect(prepared.map(item => item.entry)).toMatchObject([
			{ state: 'recoverable', argumentsStage: 'provider', call: { arguments: { raw: true } } },
			{ state: 'recoverable', argumentsStage: 'transformed', call: { arguments: { query: 42 } } },
			{ state: 'recoverable', argumentsStage: 'provider', call: { arguments: { command: 42 } } },
			{ state: 'denied', input: { command: 'echo denied' }, call: { arguments: { command: 'echo denied' } } },
		])
		await expect(executePreparedAgentToolBatch(options, prepared)).resolves.toHaveLength(4)
		expect(events.filter(event => event.type === 'tool.started')).toHaveLength(0)
		expect(events.filter(event => event.type === 'tool.finished')).toHaveLength(4)
	})

	it('awaits a subagent launch fence before tool lifecycle and invocation effects', async () => {
		const child = defineAgent('revokedChild', { instructions: 'Reply.' })
		let invoked = 0
		const binding = createAgentExecutableBinding({ id: 'delegate', description: 'Delegate.', input: child.input, output: child.output,
			implementationKind: 'subagent', definitionIdentity: getDefinitionIdentity(child)!, digestDefinition: ['agent', child.id],
			mcpOwner: null, remoteMcpName: null, outputValidation: 'already-validated-target',
			async beforeInvoke() { throw new SandboxPermissionDeniedError('owner_not_authorized') },
			async invokeValidated() { invoked += 1; return 'never' },
		})
		const parent = defineAgent('revokedParent', { instructions: 'Delegate.', subagents: { delegate: child } })
		const events: AgentPipelineEvent[] = []
		const options = { agent: parent, agentInput: 'question', calls: [{ id: 'call-1', name: 'delegate', arguments: 'input' }],
			bindings: { delegate: binding }, interceptorRuntime: directInterceptorRuntime(), invocation: { runId: 'run', rootRunId: 'run', sessionId: 's',
				invocationId: 'run', depth: 0, remainingDepth: 1, metadata: {}, signal: new AbortController().signal } as never,
			step: 1, toolTimeoutMs: 1000, decisionTimeoutMs: 1000, sink: { emit: async event => { events.push(event) } },
			remainingToolCalls: 1, remainingSubagentCalls: 1, maxToolCalls: 1, maxSubagentCalls: 1,
			maxParallelToolCalls: 1, maxParallelSubagents: 1 } as const
		const prepared = await prepareAgentToolBatch(options)
		await expect(executePreparedAgentToolBatch(options, prepared)).rejects.toMatchObject({
			code: 'SANDBOX_PERMISSION_DENIED', meta: { reason: 'owner_not_authorized' },
		})
		expect(invoked).toBe(0)
		expect(events.filter(event => event.type === 'tool.started' || event.type === 'tool.finished')).toEqual([])
	})

	it('treats a resumed approval rejection as a recoverable approval tool error', async () => {
		const tool = defineTool('reviewTool', { description: 'Review.', input: z.string(), output: z.string(), async handler() { return 'unused' } })
		const binding = createAgentExecutableBinding({ id: tool.id, description: tool.description, input: tool.input, output: tool.output,
			implementationKind: 'portable', definitionIdentity: getDefinitionIdentity(tool)!, digestDefinition: ['tool', tool.id], mcpOwner: null,
			remoteMcpName: null, outputValidation: 'required', async invokeValidated() { return 'must not run' } })
		const agent = defineAgent('reviewAgent', { instructions: 'Review.', tools: [tool], governance: ({ native, rule }) => ({
			policies: [native({ id: 'reviewPolicy', rules: [rule({ id: 'reviewRule', tools: [tool.id], effect: 'require_approval' })] })],
		}) })
		const standard = baseOptions(agent, { async text() { return { content: '', toolCalls: [{ id: 'standard-review-call', name: tool.id, arguments: 'input' }], usage, finishReason: 'tool_calls' as const } } }, 'run')
		;(standard.options as any).bindings = { [tool.id]: binding }
		attachToolRuntime(standard, { telemetry: undefined })
		const interruption = await executeStandardAgent(standard.options).catch(error => error)
		expect(interruption).toMatchObject({ code: 'TOOL_APPROVAL_PENDING', state: undefined,
			preparedState: expect.objectContaining({ entries: [expect.objectContaining({ state: 'ready', approvalId: expect.any(String) })] }) })
		const approvalEvents: AgentPipelineEvent[] = []
		const options = { agent, agentInput: 'question', calls: [{ id: 'review-call', name: tool.id, arguments: 'input' }], bindings: { [tool.id]: binding }, interceptorRuntime: directInterceptorRuntime(),
			invocation: { runId: 'review-run', rootRunId: 'review-run', sessionId: 'review-session', invocationId: 'review-run', depth: 0,
				remainingDepth: 1, metadata: {}, signal: new AbortController().signal, telemetry: undefined } as never,
			step: 1, toolTimeoutMs: 1000, decisionTimeoutMs: 1000, sink: { emit: async event => { approvalEvents.push(event) } },
			remainingToolCalls: 1, remainingSubagentCalls: 1, maxToolCalls: 1, maxSubagentCalls: 1,
			maxParallelToolCalls: 1, maxParallelSubagents: 1 } as const
		const pending = await prepareAgentToolBatch(options)
		const approval = pending[0] && 'approval' in pending[0] ? pending[0].approval : undefined
		if (!approval) throw new Error('Expected approval preflight.')
		for (const item of pending) if ('lifecycle' in item) item.lifecycle.dispose()
		const privateReviewerReason = 'private reviewer explanation must never escape'
		const rejected = await prepareAgentToolBatch({ ...options, suppliedDecisions: [{ approvalId: approval.approvalId, approved: false, reason: privateReviewerReason }] })
		expect(rejected[0]?.entry).toMatchObject({ state: 'recoverable', error: { code: 'TOOL_ERROR', meta: { tool_kind: 'approval' } } })
		const results = await executePreparedAgentToolBatch(options, rejected)
		expect(results).toEqual([expect.objectContaining({ message: expect.objectContaining({ content: expect.stringContaining('Tool approval was rejected.') }) })])
		expect(JSON.stringify({ rejected, results, approvalEvents })).not.toContain(privateReviewerReason)
	})

	it('uses the actual tool deadline in hooks and handler context', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
		const observed: number[] = []
		const tool = defineTool('deadlineTool', { description: 'Deadline.', input: z.string(), output: z.string(), async handler() { return 'unused' } })
		const binding = createAgentExecutableBinding({ id: tool.id, description: tool.description, input: tool.input, output: tool.output,
			implementationKind: 'portable', definitionIdentity: getDefinitionIdentity(tool)!, digestDefinition: ['tool', tool.id], mcpOwner: null,
			remoteMcpName: null, outputValidation: 'required', async invokeValidated(context) { observed.push(context.deadline!); return 'ok' } })
		const guardrails = { [agentGuardrailsBinding]: { id: 'deadlineGuard',
			beforeTool: ({ decision }: any) => { observed.push(decision.deadline); return { decision: 'allow' as const } },
			afterTool: ({ decision }: any) => { observed.push(decision.deadline); return { decision: 'allow' as const } },
		} }
		const agent = defineAgent('deadlineAgent', { instructions: 'Use.', tools: [tool], guardrails: guardrails as never })
		const options = { agent, agentInput: 'question', calls: [{ id: 'deadline-call', name: tool.id, arguments: 'input' }], bindings: { [tool.id]: binding }, interceptorRuntime: directInterceptorRuntime(),
			invocation: { runId: 'deadline-run', rootRunId: 'deadline-run', sessionId: 'deadline-session', invocationId: 'deadline-run', depth: 0,
				remainingDepth: 1, deadline: Date.now() + 500, metadata: {}, signal: new AbortController().signal, telemetry: undefined } as never,
			step: 1, toolTimeoutMs: 50, decisionTimeoutMs: 1000, sink: { emit: async () => {} },
			remainingToolCalls: 1, remainingSubagentCalls: 1, maxToolCalls: 1, maxSubagentCalls: 1,
			maxParallelToolCalls: 1, maxParallelSubagents: 1 } as const
		const prepared = await prepareAgentToolBatch(options)
		await executePreparedAgentToolBatch(options, prepared)
		expect(observed).toEqual([Date.now() + 50, Date.now() + 50, Date.now() + 50])
	})

	it('never duplicates tool.finished when event or checkpoint observers fail', async () => {
		const tool = defineTool('eventTool', { description: 'Event.', input: z.string(), output: z.string(), async handler() { return 'unused' } })
		let handlerCalls = 0
		const binding = createAgentExecutableBinding({ id: tool.id, description: tool.description, input: tool.input, output: tool.output,
			implementationKind: 'portable', definitionIdentity: getDefinitionIdentity(tool)!, digestDefinition: ['tool', tool.id], mcpOwner: null,
			remoteMcpName: null, outputValidation: 'required', async invokeValidated() { handlerCalls += 1; return 'ok' } })
		const agent = defineAgent('eventAgent', { instructions: 'Use.', tools: [tool] })
		const makeOptions = (emit: (event: AgentPipelineEvent) => Promise<void>) => ({ agent, agentInput: 'question', interceptorRuntime: directInterceptorRuntime(),
			calls: [{ id: 'event-call', name: tool.id, arguments: 'input' }], bindings: { [tool.id]: binding },
			invocation: { runId: 'event-run', rootRunId: 'event-run', sessionId: 'event-session', invocationId: 'event-run', depth: 0,
				remainingDepth: 1, metadata: {}, signal: new AbortController().signal, telemetry: undefined } as never,
			step: 1, toolTimeoutMs: 20, decisionTimeoutMs: 1000, sink: { emit }, remainingToolCalls: 1, remainingSubagentCalls: 1,
			maxToolCalls: 1, maxSubagentCalls: 1, maxParallelToolCalls: 1, maxParallelSubagents: 1 } as const)

		const throwingStarted: AgentPipelineEvent[] = []
		const startedOptions = makeOptions(async event => { throwingStarted.push(event); if (event.type === 'tool.started') throw new Error('started sink failed') })
		await expect(executePreparedAgentToolBatch(startedOptions, await prepareAgentToolBatch(startedOptions))).rejects.toThrow('started sink failed')
		expect(handlerCalls).toBe(0)
		expect(throwingStarted.filter(event => event.type === 'tool.finished')).toHaveLength(0)

		const throwingFinished: AgentPipelineEvent[] = []
		const finishedOptions = makeOptions(async event => { throwingFinished.push(event); if (event.type === 'tool.finished') throw new Error('finished sink failed') })
		await expect(executePreparedAgentToolBatch(finishedOptions, await prepareAgentToolBatch(finishedOptions))).rejects.toThrow('finished sink failed')
		expect(throwingFinished.filter(event => event.type === 'tool.finished')).toHaveLength(1)

		const checkpointEvents: AgentPipelineEvent[] = []
		const checkpointOptions = makeOptions(async event => { checkpointEvents.push(event) })
		const checkpointPrepared = await prepareAgentToolBatch(checkpointOptions)
		await expect(executePreparedAgentToolBatch({ ...checkpointOptions, onEntry: () => { throw new Error('checkpoint failed') } }, checkpointPrepared)).rejects.toThrow('checkpoint failed')
		expect(checkpointEvents.filter(event => event.type === 'tool.finished')).toHaveLength(1)

		vi.useFakeTimers()
		const hangingEvents: AgentPipelineEvent[] = []
		const hangingOptions = makeOptions(event => { hangingEvents.push(event); return event.type === 'tool.started' ? new Promise(() => {}) : Promise.resolve() })
		const hangingExecution = prepareAgentToolBatch(hangingOptions).then(prepared => executePreparedAgentToolBatch(hangingOptions, prepared)).catch(error => error)
		await vi.advanceTimersByTimeAsync(25)
		await expect(hangingExecution).resolves.toBeInstanceOf(OperationTimeoutError)
		expect(hangingEvents.filter(event => event.type === 'tool.finished')).toHaveLength(0)

		const hangingFinishedEvents: AgentPipelineEvent[] = []
		const hangingFinishedOptions = makeOptions(event => {
			hangingFinishedEvents.push(event)
			return event.type === 'tool.finished' ? new Promise(() => {}) : Promise.resolve()
		})
		const hangingFinishedExecution = prepareAgentToolBatch(hangingFinishedOptions)
			.then(prepared => executePreparedAgentToolBatch(hangingFinishedOptions, prepared))
			.catch(error => error)
		await vi.advanceTimersByTimeAsync(25)
		await expect(hangingFinishedExecution).resolves.toBeInstanceOf(OperationTimeoutError)
		expect(hangingFinishedEvents.filter(event => event.type === 'tool.finished')).toHaveLength(1)
	})

	it('reports exact loop budgets and preserves per-tool timeout identity with event pairing', async () => {
		const agent = defineAgent('budgetAgent', { instructions: 'Bounded.' })
		const budgetBase = { agent, agentInput: 'question', calls: [{ id: 'one', name: 'unknown', arguments: null }], bindings: {}, interceptorRuntime: directInterceptorRuntime(),
			invocation: { runId: 'run', rootRunId: 'run', sessionId: 's', invocationId: 'run', depth: 0, remainingDepth: 0,
				metadata: {}, signal: new AbortController().signal, telemetry: undefined } as never,
			step: 1, toolTimeoutMs: 1000, decisionTimeoutMs: 1000, sink: { emit: async () => {} },
			maxToolCalls: 1, maxSubagentCalls: 1, maxParallelToolCalls: 1, maxParallelSubagents: 1 } as const
		await expect(prepareAgentToolBatch({ ...budgetBase, remainingToolCalls: 0, remainingSubagentCalls: 1 })).rejects.toMatchObject({
			constructor: AgentLoopBudgetError, meta: { reason: 'max_tool_calls', limit: 1 },
		})
		const child = defineAgent('budgetChild', { instructions: 'Child.' })
		const childBinding = createAgentExecutableBinding({ id: 'delegateBudget', description: 'Delegate.', input: z.string(), output: z.string(),
			implementationKind: 'subagent', definitionIdentity: getDefinitionIdentity(child)!, digestDefinition: ['agent', child.id], mcpOwner: null,
			remoteMcpName: null, outputValidation: 'already-validated-target', async invokeValidated() { return 'ok' } })
		const childBatch = { ...budgetBase, calls: [{ id: 'child-call', name: 'delegateBudget', arguments: 'x' }], bindings: { delegateBudget: childBinding }, remainingToolCalls: 1 }
		await expect(prepareAgentToolBatch({ ...childBatch, remainingSubagentCalls: 0, invocation: { ...budgetBase.invocation, remainingDepth: 1 } })).rejects.toMatchObject({
			constructor: AgentLoopBudgetError, meta: { reason: 'max_subagent_calls', limit: 1 },
		})
		await expect(prepareAgentToolBatch({ ...childBatch, remainingSubagentCalls: 1 })).rejects.toMatchObject({
			constructor: AgentLoopBudgetError, meta: { reason: 'max_depth', limit: 0 },
		})

		vi.useFakeTimers()
		const slow = defineTool('slow', { description: 'Slow.', input: z.string(), output: z.string(), async handler() { return '' } })
		const binding = createAgentExecutableBinding({ id: slow.id, description: slow.description, input: slow.input, output: slow.output,
			implementationKind: 'portable', definitionIdentity: getDefinitionIdentity(slow)!, digestDefinition: ['tool', slow.id], mcpOwner: null,
			remoteMcpName: null, outputValidation: 'required', invokeValidated: () => new Promise(() => {}) })
		const events: AgentPipelineEvent[] = []
		const options = { ...budgetBase, calls: [{ id: 'slow-call', name: 'slow', arguments: 'x' }], bindings: { slow: binding },
			invocation: { ...budgetBase.invocation, remainingDepth: 1 }, toolTimeoutMs: 5, remainingToolCalls: 1, remainingSubagentCalls: 1,
			sink: { emit: async event => { events.push(event) } } } as const
		const prepared = await prepareAgentToolBatch(options)
		const execution = executePreparedAgentToolBatch(options, prepared).catch(error => error)
		await vi.advanceTimersByTimeAsync(10)
		await expect(execution).resolves.toBeInstanceOf(OperationTimeoutError)
		expect(events.filter(event => event.type === 'tool.started')).toHaveLength(1)
		expect(events.filter(event => event.type === 'tool.finished')).toHaveLength(1)
	})

	it('reports max_steps with the configured agent limit', async () => {
		const tool = defineTool('repeat', { description: 'Repeat.', input: z.string(), output: z.string(), async handler() { return 'unused' } })
		const binding = createAgentExecutableBinding({ id: tool.id, description: tool.description, input: tool.input, output: tool.output,
			implementationKind: 'portable', definitionIdentity: getDefinitionIdentity(tool)!, digestDefinition: ['tool', tool.id], mcpOwner: null,
			remoteMcpName: null, outputValidation: 'required', async invokeValidated() { return 'again' } })
		const agent = defineAgent('stepBudget', { instructions: 'Repeat.', tools: [tool], loop: { maxSteps: 1 } })
		const run = baseOptions(agent, { async text() { return { content: 'draft', toolCalls: [{ id: 'repeat-1', name: 'repeat', arguments: 'x' }], usage, finishReason: 'tool_calls' as const } } }, 'run')
		;(run.options as any).bindings = { repeat: binding }
		attachToolRuntime(run)
		await expect(executeStandardAgent(run.options)).rejects.toMatchObject({ constructor: AgentLoopBudgetError, meta: { reason: 'max_steps', limit: 1 } })
	})
})
