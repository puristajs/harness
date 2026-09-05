import { z } from 'zod'

import { defineAgent, defineMcpServer, defineSkill, defineTool, defineWorkflow } from '../src/definitions/index.js'
import { defineCatalog } from '../src/definitions/catalog.js'
import { defineHarness } from '../src/definitions/harness.js'
import type { ToolRequirements } from '../src/definitions/index.js'
import { agentGuardrailsBinding } from '../src/agents/guardrails.js'
import type { AgentExecutionRequirements } from '../src/harness/agent-requirements.js'
import type { AgentModelResponse, HarnessTargetStream } from '../src/index.js'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

const publicTextModelResponse: AgentModelResponse = { content: 'ok', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' }
const publicObjectModelResponse: AgentModelResponse = { object: { ok: true }, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' }
void publicTextModelResponse
void publicObjectModelResponse

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
	tools: {
		searchKnowledge: { remoteName: 'search_knowledge', description: 'Search.', input, output },
		fetchKnowledge: { remoteName: 'fetch_knowledge', description: 'Fetch.', input, output },
	},
})
const mcpToolId: 'searchKnowledge' = mcp.tools.searchKnowledge.id
type _McpInput = Expect<Equal<typeof mcp.tools.searchKnowledge.$infer.input, { message: string }>>
type _McpOutput = Expect<Equal<typeof mcp.tools.searchKnowledge.$infer.output, { answer: string }>>
void mcpToolId
// @ts-expect-error the owning server id is private type metadata
mcp.tools.searchKnowledge.serverId
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
const sandboxedChildWorkflow = defineWorkflow('sandboxedChild', {
	input, output, agents: { classify: structuredAgent }, childTaskSandboxGroups: ['reviewers'] as const,
	async handler(context) {
		const task = await context.childTasks.start('classify', context.input, { callId: 'review', sandbox: { group: 'reviewers' } })
		// @ts-expect-error child-task group overrides use only the workflow-declared vocabulary
		await context.childTasks.start('classify', context.input, { callId: 'typo', sandbox: { group: 'admins' } })
		return task.result()
	},
})
const sandboxedChildHarness = defineHarness({ name: 'sandboxedChildHarness' }).addWorkflow(sandboxedChildWorkflow)
type _ChildSandboxGroup = Expect<Equal<typeof sandboxedChildHarness.$infer.requirements.sandbox.requiredGroups[number], 'reviewers'>>
void sandboxedChildHarness
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

const catalog = defineCatalog('supportAi', {
	tools: [lookup], skills: [skill], mcpServers: [mcp], agents: [structuredAgent], workflows: [workflow],
})
const catalogToolId: 'lookup' = catalog.tools.lookup.id
const catalogAgentId: 'classify' = catalog.agents.classify.id
const catalogWorkflowId: 'resolveCase' = catalog.workflows.resolveCase.id
const catalogContractId: 'classify' = catalog.contracts.agents.classify.id
void catalogToolId
void catalogAgentId
void catalogWorkflowId
void catalogContractId
// @ts-expect-error exact catalog maps reject unknown definition ids
catalog.agents.unknown
// @ts-expect-error MCP tools remain nested under their owning server
catalog.tools.searchKnowledge
// @ts-expect-error catalogs accept definitions rather than structural string references
defineCatalog('invalidCatalog', { agents: ['classify'] })

const directHarness = defineHarness({ name: 'support' }).addAgent(structuredAgent).addWorkflow(workflow)
const usedHarness = defineHarness({ name: 'support' }).use(catalog)
const reusedCatalogHarness = usedHarness.use(catalog)
const leafHarness = defineHarness({ name: 'leaves' }).addTool(lookup).addSkill(skill).addMcpServer(mcp)
const memoryAgent = defineAgent('memoryAgent', {
	instructions: 'Remember.',
	memory: {
		capabilities: ['memory.kv', 'memory.vector_search'],
		embedding: { model: 'embeddings' },
		summary: { model: 'summary' },
	},
})
const knowledgeAgent = defineAgent('knowledgeAgent', { instructions: 'Search.', tools: [mcp.tools.searchKnowledge] })
const inferredHarness = defineHarness({ name: 'inferred' }).addAgent(memoryAgent).addAgent(knowledgeAgent)
const directAgentId: 'classify' = directHarness.catalog.agents.classify.id
const usedWorkflowId: 'resolveCase' = usedHarness.catalog.workflows.resolveCase.id
const reusedWorkflowId: 'resolveCase' = reusedCatalogHarness.catalog.workflows.resolveCase.id
const leafToolId: 'lookup' = leafHarness.catalog.tools.lookup.id
type _HarnessAgentInput = Expect<Equal<typeof directHarness.$infer.agents.classify.input, { message: string }>>
type _HarnessWorkflowOutput = Expect<Equal<typeof usedHarness.$infer.workflows.resolveCase.output, { answer: string }>>
type _MemoryCapabilities = Expect<Equal<
	typeof inferredHarness.$infer.requirements.memory.capabilities[number],
	'memory.kv' | 'memory.vector_search'
>>
type _MemoryModelAliases = Expect<Equal<
	typeof inferredHarness.$infer.requirements.memory.modelAliases[number],
	'embeddings' | 'summary'
>>
type _McpServerIds = Expect<Equal<typeof inferredHarness.$infer.requirements.mcpServers[number], 'knowledge'>>
type _InferredModelAliases = Expect<Equal<keyof typeof inferredHarness.$infer.requirements.models, 'primary' | 'embeddings' | 'summary'>>
const inferredMcpId: 'knowledge' = inferredHarness.catalog.mcpServers.knowledge.id
const inferredSiblingMcpToolId: 'fetchKnowledge' = inferredHarness.catalog.mcpServers.knowledge.tools.fetchKnowledge.id
void directAgentId
void usedWorkflowId
void reusedWorkflowId
void leafToolId
void inferredMcpId
void inferredSiblingMcpToolId
// @ts-expect-error the exact inferred MCP owner map rejects unknown nested tools
inferredHarness.catalog.mcpServers.knowledge.tools.unknown

const fullRequirementsAgent = defineAgent('fullRequirementsAgent', {
	instructions: 'Guard.', tools: [lookup], workspace: true, durable: true,
	permissions: { bash: 'require_approval' },
	guardrails: { [agentGuardrailsBinding]: {
		id: 'fullRequirements', requirements: {
			tools: ['lookup'], models: [{ alias: 'guardModel', capabilities: ['text'] }],
			memory: ['memory.text_search'], sandbox: ['sandbox.fs'], skillRuntimes: ['node'],
			durable: true, workspace: true, artifacts: true,
		},
	} },
})
const exactPermission: 'require_approval' = fullRequirementsAgent.permissions.bash
const exactGuardModelAlias: 'guardModel' = fullRequirementsAgent.guardrails[agentGuardrailsBinding].requirements.models[0].alias
const exactWorkspace: true = fullRequirementsAgent.workspace
const exactDurable: true = fullRequirementsAgent.durable
void exactPermission
void exactGuardModelAlias
void exactWorkspace
void exactDurable

const invalidGuardrailMemory: AgentExecutionRequirements = {
	// @ts-expect-error Guardrail memory requirements use the closed MemoryCapability vocabulary
	memory: ['memory.unknown'],
}
const invalidGuardrailSandbox: AgentExecutionRequirements = {
	// @ts-expect-error Guardrail sandbox requirements use sandbox capability ids only
	sandbox: ['storage.persistent'],
}
const invalidGuardrailRuntime: AgentExecutionRequirements = {
	// @ts-expect-error Guardrail Skill runtimes use the closed runtime vocabulary
	skillRuntimes: ['ruby'],
}
const invalidGuardrailFlag: AgentExecutionRequirements = {
	// @ts-expect-error presence flags can only be literal true
	durable: false,
}
void invalidGuardrailMemory
void invalidGuardrailSandbox
void invalidGuardrailRuntime
void invalidGuardrailFlag

const durableWorkflow = defineWorkflow('durableWorkflow', {
	input, output, workspace: true, durable: true,
	models: { media: { alias: 'media', capabilities: ['image_generation'] } },
	async handler({ input: value }) { return { answer: value.message } },
})
const featureHarness = defineHarness({ name: 'featureHarness' }).addAgent(fullRequirementsAgent).addWorkflow(durableWorkflow)
const durableRequired: true = featureHarness.$infer.requirements.storage.durable
const workspaceRequired: true = featureHarness.$infer.requirements.workspace
const artifactsRequired: true = featureHarness.$infer.requirements.artifacts
type _GuardMemoryCapability = Expect<Equal<typeof featureHarness.$infer.requirements.memory.capabilities[number], 'memory.text_search'>>
type _GuardSandboxCapability = Expect<Equal<typeof featureHarness.$infer.requirements.sandbox.capabilities[number], 'sandbox.fs' | 'sandbox.workspace_binding'>>
type _GuardSkillRuntime = Expect<Equal<typeof featureHarness.$infer.requirements.skillRuntimes[number], 'node'>>
type _GuardModelCapability = Expect<Equal<typeof featureHarness.$infer.requirements.models.guardModel.capabilities[number], 'text'>>
const emptyRequirementsHarness = defineHarness({ name: 'emptyRequirements' })
const durableNotRequired: false = emptyRequirementsHarness.$infer.requirements.storage.durable
const workspaceNotRequired: false = emptyRequirementsHarness.$infer.requirements.workspace
const artifactsNotRequired: false = emptyRequirementsHarness.$infer.requirements.artifacts
void durableRequired
void workspaceRequired
void artifactsRequired
void durableNotRequired
void workspaceNotRequired
void artifactsNotRequired

const bashTool = defineTool('bash', {
	description: 'Run a command.', input, output,
	async handler(_context, value) { return { answer: value.message } },
})
const approvalAgent = defineAgent('approvalAgent', {
	instructions: 'Ask first.', tools: [bashTool], permissions: { bash: 'require_approval' },
})
const approvalDurable: true = defineHarness({ name: 'approvalHarness' })
	.addAgent(approvalAgent).$infer.requirements.storage.durable
void approvalDurable

const runtimeWorkflow = defineWorkflow('runtimeWorkflow', {
	input,
	output,
	async handler({ input: value }) { return { answer: value.message } },
})
const runtimeHarness = defineHarness({ name: 'runtimeHarness' }).addWorkflow(runtimeWorkflow)
const runtimeInstancePromise = runtimeHarness.getInstance({})
declare const typedModelProvider: import('../src/ports/model-provider.js').ModelProvider
declare const typedSandbox: import('../src/sandbox/index.js').Sandbox
const groupedAgent = defineAgent('groupedRuntimeAgent', { instructions: 'Reply.', sandbox: { group: 'banking' } })
const groupedRuntimeHarness = defineHarness({ name: 'groupedRuntimeHarness' }).addAgent(groupedAgent)
type _GraphSandboxGroup = Expect<Equal<typeof groupedRuntimeHarness.$infer.requirements.sandbox.requiredGroups[number], 'banking'>>
const groupedRuntimeInstance = groupedRuntimeHarness.getInstance({
	model: { provider: typedModelProvider, model: 'model' }, sandbox: typedSandbox,
	sandboxBinding: { groups: ['banking'] as const, defaultPolicy: { group: 'banking' } },
})
const additionalGroupRuntimeInstance = groupedRuntimeHarness.getInstance({
	model: { provider: typedModelProvider, model: 'model' }, sandbox: typedSandbox,
	sandboxBinding: { groups: ['banking', 'support'] as const, defaultPolicy: { group: 'support' } },
})
// @ts-expect-error every graph-required group must be present in the configured tuple
groupedRuntimeHarness.getInstance({ model: { provider: typedModelProvider, model: 'model' }, sandbox: typedSandbox, sandboxBinding: { groups: ['support'] as const } })
// @ts-expect-error default policy cannot widen the configured group tuple
groupedRuntimeHarness.getInstance({ model: { provider: typedModelProvider, model: 'model' }, sandbox: typedSandbox, sandboxBinding: { groups: ['banking'] as const, defaultPolicy: { group: 'typo' } } })
void groupedRuntimeInstance
void additionalGroupRuntimeInstance
type InferredRuntimeInstance = Awaited<ReturnType<typeof directHarness.getInstance>>
declare const inferredRuntimeInstance: InferredRuntimeInstance
declare const dynamicTargetId: string
async function checkRuntimeSurface() {
	const instance = await runtimeInstancePromise
	const session = await instance.getSession('typedSession')
	// @ts-expect-error sandbox-free graphs do not accept caller-supplied sandbox owners
	await instance.getSession('typedSession', { sandboxOwner: { namespace: 'external', id: 'owner', instanceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' } })
	const completed = await session.workflows.runtimeWorkflow.run({ message: 'hello' })
	if (completed.status === 'completed') {
		const answer: string = completed.output.answer
		void answer
	}
	for await (const event of session.workflows.runtimeWorkflow.stream({ message: 'hello' })) {
		const sequence: number = event.sequence
		void sequence
	}
	const targetStream = session.workflows.runtimeWorkflow.stream({ message: 'hello' })
	await targetStream.cancel('typed transport disconnect')
	type _CanonicalTargetStream = Expect<typeof targetStream extends HarnessTargetStream<{ answer: string }> ? true : false>
	// @ts-expect-error unknown targets are not present on the exact definition-keyed map
	session.workflows.unknown
	// @ts-expect-error target inputs are inferred from the selected workflow contract
	await session.workflows.runtimeWorkflow.run({ message: 1 })
	// @ts-expect-error host-only context cannot enter standalone invoke options
	await session.workflows.runtimeWorkflow.run({ message: 'hello' }, { hostContext: {} })
	// @ts-expect-error target maps are readonly
	session.workflows.runtimeWorkflow = session.workflows.runtimeWorkflow

	const inferredSession = await inferredRuntimeInstance.getSession('typedAgentSession')
	const agentCompleted = await inferredSession.agents.classify.run({ message: 'hello' })
	if (agentCompleted.status === 'completed') {
		const answer: string = agentCompleted.output.answer
		void answer
	}
	const task = await inferredSession.childTasks.get('task-id')
	if (task !== undefined) {
		const status = await task.status()
		const workflowInvocationId: string = status.descriptor.workflowInvocationId
		const callId: string = status.descriptor.callId
		const modelAlias: string = status.descriptor.modelAlias
		void workflowInvocationId
		void callId
		void modelAlias
	}
	// @ts-expect-error unknown agents are not present on the exact definition-keyed map
	inferredSession.agents.unknown
	// @ts-expect-error standalone sessions have no ambiguous singular agent registry
	inferredSession.agent
	// @ts-expect-error standalone sessions have no string lookup service locator
	inferredSession.getAgent('classify')
	// @ts-expect-error arbitrary string indexing cannot bypass the exact target map
	inferredSession.agents[dynamicTargetId]
}
void checkRuntimeSurface

// @ts-expect-error catalog composition requires the hidden catalog identity
defineHarness({ name: 'copiedCatalog' }).use({ ...catalog })
// @ts-expect-error Harness structural copies do not retain the hidden definition brand
const copiedHarness: typeof directHarness = { ...directHarness }
void copiedHarness
// @ts-expect-error a Harness name is required
defineHarness({})
// @ts-expect-error immutable composition has no terminal define step
directHarness.define()
// @ts-expect-error Harness definitions are not string lookup registries
directHarness.getAgent('classify')
// @ts-expect-error MCP tools stay nested and cannot enter the non-MCP tool map
directHarness.addTool(mcp.tools.searchKnowledge)
