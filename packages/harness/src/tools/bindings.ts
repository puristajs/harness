import { createHash } from 'node:crypto'

import type { HarnessIdentity } from '../identity/index.js'
import type { Logger } from '../logger/index.js'
import type { JsonValue } from '../models/json.js'
import type { MemoryFacade } from '../ports/memory.js'
import type { HarnessTargetDispatcher } from '../ports/target-dispatcher.js'
import type { SandboxSessionBase } from '../sandbox/index.js'
import type { Infer, InferIn, ModelSchema, Schema } from '../schema/index.js'
import { projectModelSchema } from '../schema/json-schema.js'
import type { Metrics, TelemetryShim } from '../telemetry/index.js'
import type { ExecutionEvent } from '../definitions/execution-events.js'
import type { HarnessCheckpointStep } from '../runtime/steps.js'
import { canonicalJson } from '../runtime/canonical-json.js'
import { getDefinitionIdentity, type DefinitionIdentity } from '../definitions/identity.js'
import type {
	AnyAgentDefinition,
	HarnessExecutionCaller,
	BuiltInToolDefinition,
	HostToolDefinition,
	McpToolDefinition,
	ToolDefinition,
	ToolHandlerContext,
	ToolRequirements,
} from '../definitions/types.js'

export type AgentBindingKind = 'portable' | 'built-in' | 'read-skill' | 'mcp' | 'subagent' | 'host'

/** @internal Broad runtime context; binding factories project narrower handler contexts. */
export interface AgentToolInvocationContext {
	readonly caller: Extract<HarnessExecutionCaller, { kind: 'agent' }>
	readonly harnessName: string
	readonly sessionId: string
	readonly runId: string
	readonly rootRunId: string
	readonly parentRunId?: string
	readonly parentInvocationId?: string
	readonly invocationId: string
	readonly agentId: string
	readonly workflowId?: string
	readonly depth: number
	readonly remainingDepth: number
	readonly trace?: import('../telemetry/trace-context.js').HarnessTraceContext
	readonly step: number
	readonly toolId: string
	readonly callId: string
	readonly idempotencyKey?: string
	readonly identity?: HarnessIdentity
	readonly deadline?: number
	readonly signal: AbortSignal
	readonly metadata: Readonly<Record<string, JsonValue>>
	readonly logger: Logger
	readonly metrics: Metrics
	readonly telemetry: TelemetryShim
	readonly memory: MemoryFacade
	readonly sandbox: SandboxSessionBase
	readonly targetDispatcher: HarnessTargetDispatcher
	relayChildEvent(event: ExecutionEvent): Promise<void>
	readonly checkpointStep: HarnessCheckpointStep
}

/** @internal Workflow-owned tool context. It deliberately has no synthetic agent identity. */
export type WorkflowToolInvocationContext = Omit<AgentToolInvocationContext, 'caller' | 'agentId' | 'workflowId'> & Readonly<{
	caller: Extract<HarnessExecutionCaller, { kind: 'workflow' }>
	workflowId: string
	agentId?: never
}>

/** @internal Exact caller-specific context accepted by a shared executable tool binding. */
export type ToolInvocationContext = AgentToolInvocationContext | WorkflowToolInvocationContext

/** @internal Prepared implementation owned by one exact definition identity. */
export interface AgentExecutableBinding<Input extends ModelSchema = ModelSchema, Output extends Schema = Schema> {
	readonly id: string
	readonly description: string
	readonly input: Input
	readonly output: Output
	readonly implementationKind: AgentBindingKind
	readonly definitionIdentity: DefinitionIdentity
	readonly contractDigest: string
	readonly outputValidation: 'required' | 'already-validated-target'
	/** @internal Runtime-owned launch fence run before any tool lifecycle event. */
	readonly beforeInvoke?: (context: AgentToolInvocationContext) => Promise<void>
	/** @internal Releases an unused runtime-owned launch fence. */
	readonly afterInvoke?: (context: AgentToolInvocationContext) => void
	invokeValidated(context: AgentToolInvocationContext, input: Infer<Input> & JsonValue, wireInput: InferIn<Input> & JsonValue): Promise<unknown>
	/** @internal Workflow path through the same definition-authentic prepared binding. */
	readonly invokeWorkflowValidated?: (context: WorkflowToolInvocationContext, input: JsonValue, wireInput: JsonValue) => Promise<unknown>
}

/** Internal spelling retained by H4-004 runtime bundles. */
export type ExecutableToolBinding<Input extends ModelSchema = ModelSchema, Output extends Schema = Schema> = AgentExecutableBinding<Input, Output>

type DigestDefinitionKind = 'tool' | 'built-in-tool' | 'host-tool' | 'mcp-tool' | 'agent'

/** @internal Sole binding digest and freeze finalizer. */
export interface AgentExecutableBindingSource<Input extends ModelSchema = ModelSchema, Output extends Schema = Schema>
	extends Omit<AgentExecutableBinding<Input, Output>, 'contractDigest'> {
	readonly digestDefinition: readonly [DigestDefinitionKind, string]
	readonly mcpOwner: readonly ['mcp-server', string] | null
	readonly remoteMcpName: string | null
}

export function createAgentExecutableBinding<Input extends ModelSchema, Output extends Schema>(options: AgentExecutableBindingSource<Input, Output>): AgentExecutableBinding<Input, Output> {
	const expectedIdentityKind: Record<AgentBindingKind, DefinitionIdentity['kind']> = {
		portable: 'tool', 'built-in': 'built-in-tool', 'read-skill': 'agent', mcp: 'mcp-tool', subagent: 'agent', host: 'host-tool',
	}
	if (options.definitionIdentity.kind !== expectedIdentityKind[options.implementationKind]) {
		throw new TypeError('Executable binding definition identity does not match its implementation kind.')
	}
	if (options.digestDefinition[0] !== options.definitionIdentity.kind || options.digestDefinition[1] !== options.definitionIdentity.id) {
		throw new TypeError('Executable binding digest identity must match its exact definition identity.')
	}
	const isMcp = options.implementationKind === 'mcp'
	if (isMcp !== (options.mcpOwner !== null && options.remoteMcpName !== null)) {
		throw new TypeError('Only MCP bindings may contain MCP digest identity fields.')
	}
	if (isMcp) {
		const owner = options.definitionIdentity.owner
		const ownerIdentity = getDefinitionIdentity(owner)
		const ownerTool = owner !== null && typeof owner === 'object' && 'tools' in owner
			? (owner as { readonly tools?: Readonly<Record<string, unknown>> }).tools?.[options.id]
			: undefined
		if (ownerIdentity?.kind !== 'mcp-server' || options.mcpOwner?.[0] !== 'mcp-server'
			|| options.mcpOwner[1] !== ownerIdentity.id || getDefinitionIdentity(ownerTool)?.token !== options.definitionIdentity.token
			|| typeof options.remoteMcpName !== 'string' || options.remoteMcpName.length === 0
			|| (ownerTool as { readonly remoteName?: unknown } | undefined)?.remoteName !== options.remoteMcpName) {
			throw new TypeError('MCP binding must match its exact owning server and remote tool name.')
		}
	}
	const outputValidation = options.outputValidation
	if ((outputValidation === 'already-validated-target') !== (options.implementationKind === 'subagent')) {
		throw new TypeError('Only subagent bindings may skip repeated target output validation.')
	}
	const preimage = [
		'harness.binding.v1', options.id, options.implementationKind, options.digestDefinition,
		options.mcpOwner, options.remoteMcpName,
		projectModelSchema(options.input, 'tool_input', options.id),
	] as const
	const contractDigest = `sha256:${createHash('sha256').update(canonicalJson(preimage), 'utf8').digest('hex')}`
	return Object.freeze({
		id: options.id, description: options.description, input: options.input, output: options.output,
		implementationKind: options.implementationKind, definitionIdentity: options.definitionIdentity,
		contractDigest, outputValidation,
		...(options.beforeInvoke === undefined ? {} : { beforeInvoke: options.beforeInvoke }),
		...(options.afterInvoke === undefined ? {} : { afterInvoke: options.afterInvoke }),
		invokeValidated: options.invokeValidated,
		...(options.invokeWorkflowValidated === undefined ? {} : { invokeWorkflowValidated: options.invokeWorkflowValidated }),
	})
}

/** @internal Prepares one portable handler without policy, validation, or events. */
export function bindPortableTool<Id extends string, Input extends ModelSchema, Output extends Schema, Requirements extends ToolRequirements>(
	definition: ToolDefinition<Id, Input, Output, Requirements>,
): AgentExecutableBinding<Input, Output> {
	const identity = requireIdentity(definition, 'tool')
	return createAgentExecutableBinding({
		id: definition.id, description: definition.description, input: definition.input, output: definition.output,
		implementationKind: 'portable', definitionIdentity: identity, digestDefinition: ['tool', definition.id],
		mcpOwner: null, remoteMcpName: null, outputValidation: 'required',
		invokeValidated: (context, input) => definition.handler(projectPortableContext(context, definition.requires), input),
		invokeWorkflowValidated: (context, input) => definition.handler(projectPortableContext(context, definition.requires), input as Infer<Input>),
	})
}

/** @internal Prepares a built-in implementation supplied by the runtime. */
export function bindBuiltInTool<Input extends ModelSchema, Output extends Schema>(
	definition: BuiltInToolDefinition<string, Input, Output>,
	invoke: (context: ToolInvocationContext, input: Infer<Input>) => Promise<unknown>,
): AgentExecutableBinding<Input, Output> {
	const identity = requireIdentity(definition, 'built-in-tool')
	return createAgentExecutableBinding({ id: definition.id, description: definition.description, input: definition.input, output: definition.output,
		implementationKind: 'built-in', definitionIdentity: identity, digestDefinition: ['built-in-tool', definition.id],
		mcpOwner: null, remoteMcpName: null, outputValidation: 'required', invokeValidated: invoke,
		invokeWorkflowValidated: (context, input) => invoke(context, input as Infer<Input>) })
}

/** @internal Creates the generated reader owned by one exact agent definition. */
export function bindReadSkillTool<Input extends ModelSchema, Output extends Schema>(
	owner: AnyAgentDefinition,
	input: Input,
	output: Output,
	invoke: (input: Infer<Input>) => Promise<unknown>,
): AgentExecutableBinding<Input, Output> {
	const identity = requireIdentity(owner, 'agent')
	return createAgentExecutableBinding({ id: 'read_skill', description: 'Read one text file from a selected Agent Skill snapshot.', input, output,
		implementationKind: 'read-skill', definitionIdentity: identity, digestDefinition: ['agent', owner.id],
		mcpOwner: null, remoteMcpName: null, outputValidation: 'required',
		invokeValidated: (_context, value) => invoke(value) })
}

/** @internal Prepares one selected MCP tool against its owning server bundle. */
export function bindMcpTool<Input extends ModelSchema, Output extends Schema>(
	definition: McpToolDefinition<string, Input, Output>,
	invoke: (context: ToolInvocationContext, remoteName: string, input: Infer<Input>) => Promise<unknown>,
): AgentExecutableBinding<Input, Output> {
	const identity = requireIdentity(definition, 'mcp-tool')
	const owner = getDefinitionIdentity(identity.owner)
	if (owner?.kind !== 'mcp-server') throw new TypeError('MCP tool binding requires its exact owning server identity.')
	return createAgentExecutableBinding({ id: definition.id, description: definition.description, input: definition.input, output: definition.output,
		implementationKind: 'mcp', definitionIdentity: identity, digestDefinition: ['mcp-tool', definition.id],
		mcpOwner: ['mcp-server', owner.id], remoteMcpName: definition.remoteName,
		outputValidation: 'required',
		invokeValidated: (context, value) => invoke(context, definition.remoteName, value),
		invokeWorkflowValidated: (context, value) => invoke(context, definition.remoteName, value as Infer<Input>) })
}

/** @internal Creates one run-scoped host-aware binding through the canonical finalizer. */
export function bindHostTool(
	definition: HostToolDefinition<any, any, any, any>,
	invoke: (context: ToolInvocationContext, input: JsonValue, wireInput: JsonValue) => Promise<unknown>,
): AgentExecutableBinding {
	const identity = requireIdentity(definition, 'host-tool')
	return createAgentExecutableBinding({ id: definition.id, description: definition.description, input: definition.input, output: definition.output,
		implementationKind: 'host', definitionIdentity: identity, digestDefinition: ['host-tool', definition.id],
		mcpOwner: null, remoteMcpName: null, outputValidation: 'required',
		invokeValidated: invoke,
		invokeWorkflowValidated: (context, input, wireInput) => invoke(context, input, wireInput) })
}

/** @internal Reserves a host-aware binding without a standalone call path. */
export function bindHostToolSeam(definition: HostToolDefinition<any, any, any, any>): Omit<AgentExecutableBinding, 'invokeValidated'> {
	const binding = bindHostTool(definition, async () => { throw new TypeError('Host tool is not bound.') })
	const { invokeValidated: _removed, ...seam } = binding
	return Object.freeze(seam)
}


function requireIdentity(value: unknown, kind: DefinitionIdentity['kind']): DefinitionIdentity {
	const identity = getDefinitionIdentity(value)
	if (identity?.kind !== kind) throw new TypeError('Executable binding requires a package-owned definition identity.')
	return identity
}

function projectPortableContext<Requirements extends ToolRequirements>(
	context: ToolInvocationContext,
	requirements: Requirements | undefined,
): ToolHandlerContext<Requirements> {
	return Object.freeze({
		signal: context.signal, logger: context.logger, metrics: context.metrics, telemetry: context.telemetry,
		...(context.identity === undefined ? {} : { identity: context.identity }), sessionId: context.sessionId,
		runId: context.runId, caller: context.caller, toolId: context.toolId, callId: context.callId,
		invocationId: context.invocationId, ...(context.idempotencyKey === undefined ? {} : { idempotencyKey: context.idempotencyKey }),
		metadata: context.metadata,
		...((requirements?.memory?.length ?? 0) === 0 ? {} : { memory: context.memory }),
		...((requirements?.sandbox?.length ?? 0) === 0 ? {} : { sandbox: context.sandbox }),
	}) as ToolHandlerContext<Requirements>
}
