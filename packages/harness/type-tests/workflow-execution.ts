import { z } from 'zod'

import { defineAgent } from '../src/definitions/agent.js'
import { defineWorkflow } from '../src/definitions/workflow.js'

const worker = defineAgent('worker', {
	input: z.object({ value: z.string() }), output: z.object({ answer: z.string() }),
	instructions: 'Answer.', prompt: input => ({ role: 'user', content: input.value }),
})

defineWorkflow('ephemeral', {
	input: z.string(), output: z.string(), agents: { worker },
	async handler(context) {
		// @ts-expect-error externalWait exists only on a literally durable workflow
		context.externalWait
		const output = await context.agents.worker.run({ value: context.input }, { callId: 'direct' })
		const oneShot = await context.childTasks.start('worker', { value: context.input }, { callId: 'task' })
		const continuable = await context.childTasks.start('worker', { value: context.input }, { callId: 'chat', mode: 'continuable' })
		await continuable.send({ value: 'next' })
		await continuable.close()
		await oneShot.result()
		// @ts-expect-error undeclared agent handles are absent
		context.agents.other
		// @ts-expect-error direct calls require callId
		await context.agents.worker.run({ value: 'x' }, {})
		// @ts-expect-error child-task starts require callId
		await context.childTasks.start('worker', { value: 'x' })
		// @ts-expect-error continuable tasks cannot declare an idempotency key
		await context.childTasks.start('worker', { value: 'x' }, { callId: 'bad', mode: 'continuable', idempotencyKey: 'bad' })
		return output.answer
	},
})

defineWorkflow('durable', {
	input: z.string(), output: z.string(), durable: true,
	async handler(context) {
		const result = await context.externalWait.wait({
			waitId: 'review-1', kind: 'review', schemaVersion: '1', definitionVersion: '1', deadline: new Date().toISOString(),
		})
		return result.status
	},
})

defineWorkflow('modelScope', {
	input: z.string(), output: z.string(),
	models: { primaryText: { alias: 'primary', capabilities: ['text'] } },
	async handler(context) {
		void context.models.primaryText.text
		// @ts-expect-error undeclared model handles are absent
		context.models.embeddings
		// @ts-expect-error a text-only handle has no embedding operation
		context.models.primaryText.embed
		return context.input
	},
})

// @ts-expect-error workflow agent-call limits are positive numbers, not strings
defineWorkflow('badBudget', { input: z.string(), output: z.string(), agentCalls: { maxCalls: '2' }, async handler({ input }) { return input } })
// @ts-expect-error workflow child-task options cannot override model selection
const invalidTaskOptions: import('../src/definitions/types.js').ChildTaskStartOptions = { callId: 'task', model: 'fast' }
void invalidTaskOptions
