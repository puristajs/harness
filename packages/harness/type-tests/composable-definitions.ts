import { z } from 'zod'

import { defineAgent, defineMcpServer, defineSkill, defineTool, defineWorkflow } from '../src/definitions/index.js'
import type { ToolRequirements } from '../src/definitions/index.js'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

const input = z.object({ message: z.string() })
const output = z.object({ answer: z.string() })
const transformedInput = z.string().transform(value => value.length)

const lookup = defineTool('lookup', {
	description: 'Look up a message.', input, output,
	async handler(context, value) {
		const message: string = value.message
		const signal: AbortSignal = context.signal
		// @ts-expect-error an undeclared tool requirement does not expose memory
		context.memory
		// @ts-expect-error an undeclared tool requirement does not expose a sandbox
		context.sandbox
		return { answer: message + String(signal.aborted) }
	},
})

const transformedTool = defineTool('transformed', {
	description: 'Use a transformed input.', input: transformedInput, output: z.number(),
	async handler(_context, value) {
		const validated: number = value
		return validated
	},
})
type _TransformedToolInput = Expect<Equal<typeof transformedTool.$infer.input, string>>
type _TransformedToolValidatedInput = Expect<Equal<typeof transformedTool.$infer.validatedInput, number>>

const stateful = defineTool('stateful', {
	description: 'Use declared state and execution.', input, output,
	requires: { memory: ['memory.kv', 'memory.delete'], sandbox: ['sandbox.exec'] },
	async handler(context, value) {
		await context.memory.session.write('message', value.message)
		await context.memory.session.delete('message')
		await context.sandbox.exec('echo ok')
		// @ts-expect-error memory.list was not declared
		await context.memory.session.list()
		return { answer: value.message }
	},
})
void stateful

defineTool('filesystemOnly', {
	description: 'Read one file.', input, output, requires: { sandbox: ['sandbox.fs'] },
	async handler(context, value) {
		await context.sandbox.readText('/workspace/input.txt')
		// @ts-expect-error sandbox.exec was not declared
		await context.sandbox.exec('echo unsafe')
		// @ts-expect-error tool handlers cannot close the runtime-owned sandbox lifecycle
		await context.sandbox.close()
		return { answer: value.message }
	},
})

defineTool('executionOnly', {
	description: 'Execute one command.', input, output, requires: { sandbox: ['sandbox.exec'] },
	async handler(context, value) {
		await context.sandbox.exec('echo ok')
		// @ts-expect-error sandbox.fs was not declared
		await context.sandbox.readText('/workspace/input.txt')
		// @ts-expect-error tool handlers cannot close the runtime-owned sandbox lifecycle
		await context.sandbox.close()
		return { answer: value.message }
	},
})

defineTool('textSearchOnly', {
	description: 'Search sandbox text.', input, output, requires: { sandbox: ['sandbox.text_search'] },
	async handler(context, value) {
		void context.sandbox.searchText
		// @ts-expect-error sandbox.fs was not declared
		void context.sandbox.readText
		// @ts-expect-error sandbox.exec was not declared
		void context.sandbox.exec
		// @ts-expect-error tool handlers cannot close the runtime-owned sandbox lifecycle
		void context.sandbox.close
		return { answer: value.message }
	},
})

defineTool('spawnOnly', {
	description: 'Spawn one process.', input, output, requires: { sandbox: ['sandbox.spawn'] },
	async handler(context, value) {
		void context.sandbox.spawn
		// @ts-expect-error sandbox.fs was not declared
		void context.sandbox.readText
		// @ts-expect-error sandbox.exec was not declared
		void context.sandbox.exec
		// @ts-expect-error tool handlers cannot close the runtime-owned sandbox lifecycle
		void context.sandbox.close
		return { answer: value.message }
	},
})

// @ts-expect-error tool sandbox requirements accept sandbox capability ids only
const storageRequirement: ToolRequirements = { sandbox: ['storage.persistent'] }
void storageRequirement

// @ts-expect-error tool handler output must satisfy the output schema input
defineTool('badToolOutput', { description: 'bad', input, output, async handler() { return { answer: 1 } } })
// @ts-expect-error unknown tool definition fields are rejected
defineTool('badToolField', { description: 'bad', input, output, extra: true, async handler() { return { answer: 'ok' } } })

const skill = defineSkill('support-policy', { directory: new URL('./support-policy/', import.meta.url) })
// @ts-expect-error Skill runtimes are a closed union
defineSkill('bad-runtime', { directory: new URL('./bad/', import.meta.url), runtimes: ['ruby'] })
// @ts-expect-error unknown Skill definition fields are rejected
defineSkill('bad-field', { directory: new URL('./bad/', import.meta.url), install: 'npm install' })

const mcp = defineMcpServer('knowledge', {
	tools: { searchKnowledge: { remoteName: 'search_knowledge', description: 'Search.', input, output } },
})
const mcpToolId: 'searchKnowledge' = mcp.tools.searchKnowledge.id
type _McpInput = Expect<Equal<typeof mcp.tools.searchKnowledge.$infer.input, { message: string }>>
type _McpOutput = Expect<Equal<typeof mcp.tools.searchKnowledge.$infer.output, { answer: string }>>
void mcpToolId
// @ts-expect-error MCP definitions never contain runtime transport
defineMcpServer('badMcp', { url: 'https://example.com', tools: { search: { remoteName: 'search', description: 'Search.', input, output } } })

const textAgent = defineAgent('assistant', { instructions: 'Help.', tools: [lookup], skills: [skill] })
type _TextInput = Expect<Equal<typeof textAgent.$infer.input, string>>
type _TextOutput = Expect<Equal<typeof textAgent.$infer.output, string>>
const agentId: 'assistant' = textAgent.id
const agentKind: 'agent' = textAgent.kind
const primaryModel: 'primary' = textAgent.model
void agentId
void agentKind
void primaryModel

const structuredAgent = defineAgent('classify', {
	input, output, instructions: 'Classify.', tools: [lookup, mcp.tools.searchKnowledge], skills: [skill],
	prompt: value => ({ role: 'user', content: value.message }),
})
type _StructuredInput = Expect<Equal<typeof structuredAgent.$infer.input, { message: string }>>
type _StructuredOutput = Expect<Equal<typeof structuredAgent.$infer.output, { answer: string }>>

const transformedAgent = defineAgent('measure', {
	input: transformedInput, instructions: 'Measure.', prompt: value => ({ role: 'user', content: String(value) }),
})
type _TransformedAgentInput = Expect<Equal<typeof transformedAgent.$infer.input, string>>
type _TransformedAgentValidatedInput = Expect<Equal<typeof transformedAgent.$infer.validatedInput, number>>

const explicitStringOutput = defineAgent('extractText', { output: z.string(), instructions: 'Extract.' })
const structuredUpdates: 'object-snapshot' = explicitStringOutput.contract.updates
void structuredUpdates

const parent = defineAgent('parent', {
	instructions: 'Delegate.',
	subagents: { helper: textAgent, reviewer: { agent: structuredAgent, description: 'Review classifications.' } },
})
const helperId: 'assistant' = parent.subagents.helper.id
const reviewerId: 'classify' = parent.subagents.reviewer.agent.id
void helperId
void reviewerId

// @ts-expect-error a supplied input schema requires a prompt mapper
defineAgent('missingPrompt', { input, instructions: 'bad' })
// @ts-expect-error agents do not accept custom execution handlers
defineAgent('customAgent', { instructions: 'bad', async handler() { return 'bad' } })
// @ts-expect-error agent definitions reject unknown fields
defineAgent('unknownAgentField', { instructions: 'bad', temperature: 0 })
// @ts-expect-error instructions are static strings
defineAgent('callbackInstructions', { instructions: () => 'bad' })
// @ts-expect-error update modes are derived from the output contract
defineAgent('manualUpdates', { instructions: 'bad', updates: 'none' })
// @ts-expect-error tools use definition references
defineAgent('stringTool', { instructions: 'bad', tools: ['lookup'] })
// @ts-expect-error Skills use definition references
defineAgent('stringSkill', { instructions: 'bad', skills: ['support-policy'] })
// @ts-expect-error subagents use direct definitions
defineAgent('stringSubagent', { instructions: 'bad', subagents: { helper: 'assistant' } })
// @ts-expect-error structural lookalikes are not definition references
defineAgent('structuralTool', { instructions: 'bad', tools: [{ kind: 'tool', id: 'lookup', description: 'bad', input, output, handler: lookup.handler }] })
defineAgent('badPromptRole', {
	input, instructions: 'bad',
	// @ts-expect-error prompt messages can only have the user role
	prompt: value => ({ role: 'system', content: value.message }),
})
defineAgent('undeclaredImage', {
	input, instructions: 'bad',
	// @ts-expect-error image content requires vision_input
	prompt: () => ({ role: 'user', content: [{ kind: 'image_url', url: 'https://example.com/a.png' }] }),
})
defineAgent('visionAgent', {
	input, instructions: 'See.', inputCapabilities: ['vision_input'],
	prompt: () => ({ role: 'user', content: [{ kind: 'image_url', url: 'https://example.com/a.png' }] }),
})

const workflow = defineWorkflow('resolveCase', {
	input, output, agents: { classify: structuredAgent },
	models: { embeddings: { alias: 'embeddings', capabilities: ['embeddings'] } },
	async handler(context) {
		const child = await context.agents.classify.run(context.input, { callId: 'classify' })
		const embedding = await context.models.embeddings.embed({ input: 'text' }, context.signal)
		const task = await context.childTasks.start('classify', context.input, { callId: 'classifyTask' })
		await task.result()
		// @ts-expect-error undeclared agents are unavailable
		context.agents.assistant
		// @ts-expect-error undeclared models are unavailable
		context.models.fast
		// @ts-expect-error workflow direct agent calls require a stable callId
		await context.agents.classify.run(context.input)
		// @ts-expect-error workflow direct agent calls cannot override the target model
		await context.agents.classify.run(context.input, { callId: 'badModel', model: 'fast' })
		// @ts-expect-error workflow child tasks require a stable callId
		await context.childTasks.start('classify', context.input)
		// @ts-expect-error workflow child tasks cannot override the target model
		await context.childTasks.start('classify', context.input, { callId: 'badTaskModel', model: 'fast' })
		// @ts-expect-error workflow memory is not implicitly available
		context.memory
		// @ts-expect-error workflow output is not a writable context slot
		context.output
		return { answer: child.answer + String(embedding.embeddings.length) }
	},
})
type _WorkflowInput = Expect<Equal<typeof workflow.$infer.input, { message: string }>>
type _WorkflowOutput = Expect<Equal<typeof workflow.$infer.output, { answer: string }>>
const workflowUpdates: 'none' = workflow.contract.updates
void workflowUpdates

const transformedWorkflow = defineWorkflow('transformInput', {
	input: transformedInput, output: z.number(),
	async handler(context) {
		const validated: number = context.input
		return validated
	},
})
type _TransformedWorkflowInput = Expect<Equal<typeof transformedWorkflow.$infer.input, string>>
type _TransformedWorkflowValidatedInput = Expect<Equal<typeof transformedWorkflow.$infer.validatedInput, number>>

// @ts-expect-error workflow input is required
defineWorkflow('missingInput', { output, async handler() { return { answer: 'bad' } } })
// @ts-expect-error workflow output is required
defineWorkflow('missingOutput', { input, async handler() { return { answer: 'bad' } } })
// @ts-expect-error workflow handler is required
defineWorkflow('missingHandler', { input, output })
// @ts-expect-error workflow handler output must satisfy its schema input
defineWorkflow('badWorkflowOutput', { input, output, async handler() { return { answer: 1 } } })
// @ts-expect-error workflow definitions reject unknown fields
defineWorkflow('badWorkflowField', { input, output, retries: 3, async handler() { return { answer: 'ok' } } })

void workflow
