import type { Logger } from '../logger/index.js'
import type { HarnessIdentity } from '../identity/index.js'
import type { JsonValue } from '../models/json.js'
import type { ModelHandle } from '../models/registry.js'
import type { AdapterCapability } from '../ports/capabilities.js'
import type { MemoryCapability, MemoryScopeKind, SessionMemory } from '../ports/memory/types.js'
import type { ModelCapability, ContentPart } from '../ports/model-provider.js'
import type {
	ExecCapableSandboxSession,
	SandboxSessionBase,
	SpawnCapableSandboxSession,
	TextSearchCapableSandboxSession,
} from '../sandbox/index.js'
import type { SandboxPolicy } from '../sandbox/ownership.js'
import type { Infer, InferIn, ModelSchema, Schema } from '../schema/index.js'
import type { Metrics, TelemetryShim } from '../telemetry/index.js'
import type { AgentGuardrailsBinding, AgentPermissions } from '../harness/defineHarness.js'
import type { AgentGovernanceInput, GovernanceConfig } from '../governance/types.js'
import type { DurableStepOptions } from '../runtime/steps.js'
import type { ExternalWaitRequest, ExternalWaitResolved } from '../storage/external-wait.js'
import type { DefinitionReference, NonMcpToolIdentityKind } from './identity.js'

/** Executable definition families addressable through a Harness target contract. */
export type HarnessTargetKind = 'agent' | 'workflow'
/** Invocation modes supported by every Harness target. */
export type HarnessExecutionMode = 'run' | 'stream'
/** Progressive output family a target emits before its terminal outcome. */
export type HarnessOutputUpdateKind = 'none' | 'text-delta' | 'object-snapshot'
/** Resumable interruption families a target may produce. */
export type HarnessInterruptKind = 'tool-approval' | 'external-wait'

/** Portable data-only contract exposed by an executable Harness target. */
export interface HarnessTargetContract<
	Kind extends HarnessTargetKind,
	Id extends string,
	Input extends ModelSchema,
	Output extends ModelSchema,
	Updates extends HarnessOutputUpdateKind,
	Interrupts extends readonly HarnessInterruptKind[],
> {
	readonly kind: Kind
	readonly id: Id
	readonly description?: string
	readonly input: Input
	readonly output: Output
	readonly executionModes: readonly ['run', 'stream']
	readonly updates: Updates
	readonly interrupts: Interrupts
}

/** Type-only input, validated-input, and output projection on a definition. */
export interface DefinitionInference<Input extends Schema, Output extends Schema> {
	readonly input: InferIn<Input>
	readonly validatedInput: Infer<Input>
	readonly output: Infer<Output>
}

/** Runtime capabilities required before a portable tool can execute. */
export interface ToolRequirements<
	Memory extends readonly MemoryCapability[] = readonly MemoryCapability[],
	Sandbox extends readonly SandboxCapabilityId[] = readonly SandboxCapabilityId[],
> {
	readonly memory?: Memory
	readonly sandbox?: Sandbox
}

/** Sandbox-only subset accepted by portable tool requirements. */
export type SandboxCapabilityId = Extract<AdapterCapability, `sandbox.${string}`>

type HasCapability<C extends readonly string[], Capability extends string> = Capability extends C[number] ? true : false

type SessionMemoryFor<C extends readonly MemoryCapability[]> =
	(HasCapability<C, 'memory.kv'> extends true ? Pick<SessionMemory, 'read' | 'write'> : object)
	& (HasCapability<C, 'memory.delete'> extends true ? Pick<SessionMemory, 'delete'> : object)
	& (HasCapability<C, 'memory.list'> extends true ? Pick<SessionMemory, 'list'> : object)
	& (Extract<C[number], 'memory.text_search' | 'memory.vector_search' | 'memory.hybrid_search'> extends never
		? object
		: Pick<SessionMemory, 'search'>)

/** Memory facade narrowed to the capabilities declared by one tool. */
export interface ToolMemoryFacade<C extends readonly MemoryCapability[]> {
	readonly application: SessionMemoryFor<C>
	readonly session: SessionMemoryFor<C>
	readonly run: SessionMemoryFor<C>
	readonly agent?: SessionMemoryFor<C>
	tenant(): SessionMemoryFor<C>
	principal(): SessionMemoryFor<C>
	scope(kind: MemoryScopeKind): SessionMemoryFor<C>
}

/** Content-free execution context common to portable native tool handlers. */
export interface ToolHandlerContextBase {
	readonly signal: AbortSignal
	readonly logger: Logger
	readonly metrics: Metrics
	readonly telemetry: TelemetryShim
	readonly identity?: HarnessIdentity
	readonly sessionId: string
	readonly runId: string
	readonly agentId: string
	readonly toolId: string
	readonly callId: string
	readonly invocationId: string
	readonly idempotencyKey?: string
	readonly metadata: Readonly<Record<string, JsonValue>>
}

type ToolMemoryContext<R extends ToolRequirements> = R extends { memory: infer C extends readonly MemoryCapability[] }
	? { readonly memory: ToolMemoryFacade<C> }
	: object
type SandboxFileMethods = Pick<
	SandboxSessionBase,
	'read' | 'readText' | 'write' | 'remove' | 'list' | 'stat' | 'exists' | 'mount'
>

/** Tool-visible sandbox operations narrowed to explicitly required capabilities. */
export type ToolSandboxFacade<C extends readonly SandboxCapabilityId[]> =
	(HasCapability<C, 'sandbox.fs'> extends true ? SandboxFileMethods : object)
	& (HasCapability<C, 'sandbox.text_search'> extends true ? Pick<TextSearchCapableSandboxSession, 'searchText'> : object)
	& (HasCapability<C, 'sandbox.exec'> extends true ? Pick<ExecCapableSandboxSession, 'exec'> : object)
	& (HasCapability<C, 'sandbox.spawn'> extends true ? Pick<SpawnCapableSandboxSession, 'spawn'> : object)

type ToolSandboxContext<R extends ToolRequirements> = R extends { sandbox: infer C extends readonly SandboxCapabilityId[] }
	? { readonly sandbox: ToolSandboxFacade<C> }
	: object

/** Handler context whose memory and sandbox handles follow the declared requirements. */
export type ToolHandlerContext<R extends ToolRequirements> = ToolHandlerContextBase & ToolMemoryContext<R> & ToolSandboxContext<R>

/** Authoring input for a portable native TypeScript tool. */
export interface ToolOptions<Input extends ModelSchema, Output extends Schema, Requires extends ToolRequirements> {
	readonly description: string
	readonly input: Input
	readonly output: Output
	readonly requires?: Requires
	readonly handler: (
		context: ToolHandlerContext<Requires>,
		input: Infer<Input>,
	) => Promise<InferIn<Output>>
}

/** Shared identity-bearing model-facing contract for every non-MCP tool. */
export type NonMcpToolDefinition<
	IdentityKind extends NonMcpToolIdentityKind,
	Id extends string,
	Input extends ModelSchema,
	Output extends Schema,
> = Readonly<{
	kind: 'tool'
	id: Id
	description: string
	input: Input
	output: Output
	readonly $infer: DefinitionInference<Input, Output>
}> & DefinitionReference<IdentityKind, Id>

/** Frozen portable native tool reference. */
export type ToolDefinition<
	Id extends string = string,
	Input extends ModelSchema = ModelSchema,
	Output extends Schema = Schema,
	Requires extends ToolRequirements = ToolRequirements,
> = NonMcpToolDefinition<'tool', Id, Input, Output> & Readonly<{
	requires?: Requires
	handler: ToolOptions<Input, Output, Requires>['handler']
}>

/** Immutable built-in tool reference supplied by the Harness package. */
export type BuiltInToolDefinition<
	Id extends string = string,
	Input extends ModelSchema = ModelSchema,
	Output extends Schema = Schema,
> = NonMcpToolDefinition<'built-in-tool', Id, Input, Output> & Readonly<{
	requires: ToolRequirements<readonly [], readonly SandboxCapabilityId[]>
}>

/** Immutable host-aware tool reference supplied by an integrator package. */
export type HostToolDefinition<
	Id extends string = string,
	Input extends ModelSchema = ModelSchema,
	Output extends Schema = Schema,
	HostContext = unknown,
> = NonMcpToolDefinition<'host-tool', Id, Input, Output> & Readonly<{
	handler: (context: HostContext, input: Infer<Input>) => Promise<InferIn<Output>>
}>

/** Authoring contract for one selected tool on an MCP server. */
export interface McpToolOptions<Input extends ModelSchema = ModelSchema, Output extends Schema = Schema> {
	readonly remoteName: string
	readonly description: string
	readonly input: Input
	readonly output: Output
}

/** Frozen model-facing reference to one declared MCP tool. */
export type McpToolDefinition<
	Id extends string = string,
	Input extends ModelSchema = ModelSchema,
	Output extends Schema = Schema,
	Owner extends McpServerDefinition<any, any> = McpServerDefinition<string, any>,
> = Readonly<McpToolOptions<Input, Output> & {
	kind: 'tool'
	id: Id
	readonly $infer: DefinitionInference<Input, Output>
}> & DefinitionReference<'mcp-tool', Id, { readonly owner: Owner }>

/** Closed set of identity-bearing non-MCP tool definitions. */
export type AnyNonMcpToolDefinition =
	| ToolDefinition<any, any, any, any>
	| BuiltInToolDefinition<any, any, any>
	| HostToolDefinition<any, any, any, any>

/** Identity-bearing non-MCP or MCP tool reference accepted by agents. */
export type AnyToolDefinition = AnyNonMcpToolDefinition | McpToolDefinition<any, any, any>

/** Frozen transport-free declaration of an MCP server and its selected tools. */
export type McpServerDefinition<Id extends string, Tools extends Record<string, McpToolDefinition>> = Readonly<{
	kind: 'mcp-server'
	id: Id
	tools: Readonly<Tools>
}> & DefinitionReference<'mcp-server', Id>

/** Closed logical runtime vocabulary for Agent Skill availability checks. */
export type SkillRuntimeId = 'node' | 'python' | 'shell'

/** Frozen Agent Skill directory reference and its availability requirements. */
export type SkillDefinition<Id extends string = string, Runtimes extends readonly SkillRuntimeId[] = readonly SkillRuntimeId[]> = Readonly<{
	kind: 'skill'
	id: Id
	directory: URL
	runtimes?: Runtimes
}> & DefinitionReference<'skill', Id>

/** Lower-camel runtime model alias referenced by definitions. */
export type ModelAliasId = string
/** Non-text prompt content capabilities an agent may require. */
export type AgentInputCapability = 'vision_input' | 'audio_input' | 'file_input'

type TextPromptPart = Extract<ContentPart, { kind: 'text' }>
type VisionPromptPart = Extract<ContentPart, { kind: 'image' | 'image_url' }>
type AudioPromptPart = Extract<ContentPart, { kind: 'audio' }>
type FilePromptPart = Extract<ContentPart, { kind: 'file' | 'file_url' }>
type PromptPart<C extends readonly AgentInputCapability[]> =
	| TextPromptPart
	| (HasCapability<C, 'vision_input'> extends true ? VisionPromptPart : never)
	| (HasCapability<C, 'audio_input'> extends true ? AudioPromptPart : never)
	| (HasCapability<C, 'file_input'> extends true ? FilePromptPart : never)

/** Provider-neutral user message returned by an agent prompt mapper. */
export interface UserModelMessage<C extends readonly AgentInputCapability[] = readonly []> {
	readonly role: 'user'
	readonly content: string | readonly PromptPart<C>[]
}

/** Pure mapping from validated agent input to model-visible user messages. */
export type AgentPrompt<Input, Capabilities extends readonly AgentInputCapability[]> = (
	input: Input,
) => UserModelMessage<Capabilities> | readonly UserModelMessage<Capabilities>[]

/** Closed bounded-loop settings for the standard agent loop. */
export interface AgentLoopOptions {
	readonly maxSteps?: number
	readonly maxToolCalls?: number
	readonly maxSubagentCalls?: number
	readonly maxParallelSubagents?: number
	readonly maxDepth?: number
}

/** Agent memory requirements without a live memory adapter. */
export interface AgentMemoryPolicy<C extends readonly MemoryCapability[]> {
	readonly capabilities: C
	readonly embedding?: Readonly<{ model: ModelAliasId }>
	readonly summary?: Readonly<{ model: ModelAliasId; everyTurns?: number; sourceTurns?: number }>
}

/** Identity-bearing agent shape accepted by reusable agent and workflow references. */
export type AnyAgentDefinition = Readonly<{
	kind: 'agent'
	id: string
	description?: string | undefined
	model: ModelAliasId
	instructions: string
	input: ModelSchema
	output: ModelSchema
	inputCapabilities?: readonly AgentInputCapability[] | undefined
	tools?: readonly AnyToolDefinition[] | undefined
	skills?: readonly SkillDefinition[] | undefined
	guardrails?: AgentGuardrailsBinding | undefined
	permissions?: AgentPermissions | undefined
	governance?: GovernanceConfig<any> | undefined
	subagents?: AgentSubagentMap | undefined
	loop?: AgentLoopOptions | undefined
	prompt?: AgentPrompt<any, any> | undefined
	memory?: AgentMemoryPolicy<readonly MemoryCapability[]> | undefined
	sandbox?: SandboxPolicy | undefined
	workspace?: true | undefined
	durable?: true | undefined
	contract: HarnessTargetContract<'agent', string, ModelSchema, ModelSchema, 'text-delta' | 'object-snapshot', readonly ['tool-approval']>
	readonly $infer: { readonly input: any; readonly validatedInput: any; readonly output: any }
}> & DefinitionReference<'agent', string>
/** Direct child-agent reference or its parent-facing description override. */
export type AgentSubagentReference = AnyAgentDefinition | Readonly<{ agent: AnyAgentDefinition; description?: string }>
/** Provider-facing delegation names mapped to direct child-agent references. */
export type AgentSubagentMap = Readonly<Record<string, AgentSubagentReference>>

type AgentPromptField<I extends ModelSchema | undefined, C extends readonly AgentInputCapability[]> =
	I extends ModelSchema
		? { readonly input: I; readonly prompt: AgentPrompt<Infer<I>, C> }
		: { readonly input?: never; readonly prompt?: AgentPrompt<string, C> }
type AgentOutputField<O extends ModelSchema | undefined> = O extends ModelSchema
	? { readonly output: O }
	: { readonly output?: never }

/** Closed authoring fields for a configurable standard-loop agent. */
export type AgentOptions<
	Input extends ModelSchema | undefined,
	Output extends ModelSchema | undefined,
	Model extends ModelAliasId,
	Tools extends readonly AnyToolDefinition[] | undefined,
	Skills extends readonly SkillDefinition[] | undefined,
	Subagents extends AgentSubagentMap | undefined,
	Capabilities extends readonly AgentInputCapability[],
	Memory extends AgentMemoryPolicy<readonly MemoryCapability[]> | undefined,
	Guardrails extends AgentGuardrailsBinding<any> | undefined = undefined,
	Permissions extends AgentPermissions | undefined = undefined,
	Governance extends AgentGovernanceInput<Tools, Skills, Subagents> | undefined = undefined,
	Workspace extends true | undefined = undefined,
	Durable extends true | undefined = undefined,
	Sandbox extends SandboxPolicy | undefined = undefined,
> = AgentPromptField<Input, Capabilities> & AgentOutputField<Output> & {
	readonly description?: string
	readonly model?: Model
	readonly instructions: string
	readonly inputCapabilities?: Capabilities
	readonly tools?: Tools
	readonly skills?: Skills
	readonly guardrails?: Guardrails
	readonly permissions?: Permissions
	readonly governance?: Governance
	readonly subagents?: Subagents
	readonly loop?: AgentLoopOptions
	readonly memory?: Memory
	readonly sandbox?: Sandbox
	readonly workspace?: Workspace
	readonly durable?: Durable
}

type PresentField<Key extends PropertyKey, Value> = undefined extends Value
	? { readonly [K in Key]?: undefined }
	: { readonly [K in Key]: Value }

/** Frozen definition of one standard model-loop agent. */
export type AgentDefinition<
	Id extends string,
	Input extends ModelSchema,
	Output extends ModelSchema,
	Model extends ModelAliasId = ModelAliasId,
	Tools extends readonly AnyToolDefinition[] | undefined = undefined,
	Skills extends readonly SkillDefinition[] | undefined = undefined,
	Subagents extends AgentSubagentMap | undefined = undefined,
	Capabilities extends readonly AgentInputCapability[] = readonly [],
 	Updates extends 'text-delta' | 'object-snapshot' = 'text-delta' | 'object-snapshot',
	Prompt extends AgentPrompt<any, Capabilities> | undefined = AgentPrompt<Infer<Input>, Capabilities> | undefined,
	Memory extends AgentMemoryPolicy<readonly MemoryCapability[]> | undefined = undefined,
	Guardrails extends AgentGuardrailsBinding<any> | undefined = undefined,
	Permissions extends AgentPermissions | undefined = undefined,
	Governance extends GovernanceConfig<any> | undefined = undefined,
	Workspace extends true | undefined = undefined,
	Durable extends true | undefined = undefined,
	Sandbox extends SandboxPolicy | undefined = undefined,
> = Readonly<{
	kind: 'agent'
	id: Id
	description?: string
	model: Model
	input: Input
	output: Output
	instructions: string
	inputCapabilities?: Capabilities
	loop?: AgentLoopOptions
	contract: HarnessTargetContract<'agent', Id, Input, Output, Updates, readonly ['tool-approval']>
	readonly $infer: DefinitionInference<Input, Output>
}> & PresentField<'prompt', Prompt> & PresentField<'tools', Tools> & PresentField<'skills', Skills> & PresentField<'subagents', Subagents>
	& PresentField<'memory', Memory>
	& PresentField<'guardrails', Guardrails>
	& PresentField<'permissions', Permissions>
	& PresentField<'governance', Governance>
	& PresentField<'workspace', Workspace>
	& PresentField<'durable', Durable>
	& PresentField<'sandbox', Sandbox>
	& DefinitionReference<'agent', Id>

/** One model alias and its exact workflow-visible capabilities. */
export interface WorkflowModelRequirement<C extends readonly [ModelCapability, ...ModelCapability[]] = readonly [ModelCapability, ...ModelCapability[]]> {
	readonly alias: ModelAliasId
	readonly capabilities: C
}

/** Exact agent allowlist visible to one workflow handler. */
export type WorkflowAgentMap = Readonly<Record<string, AnyAgentDefinition>>
/** Exact model-handle allowlist visible to one workflow handler. */
export type WorkflowModelMap = Readonly<Record<string, WorkflowModelRequirement>>

type WorkflowAgentInvokers<Agents extends WorkflowAgentMap | undefined> = Agents extends WorkflowAgentMap
	? { readonly [K in keyof Agents]: {
		readonly run: (
			input: Agents[K]['$infer']['input'],
			options: Readonly<{ callId: string; signal?: AbortSignal; idempotencyKey?: string }>,
		) => Promise<Agents[K]['$infer']['output']>
	} }
	: Record<never, never>

type WorkflowModelHandles<Models extends WorkflowModelMap | undefined> = Models extends WorkflowModelMap
	? { readonly [K in keyof Models]: ModelHandle<Models[K]> }
	: Record<never, never>

/** Content policy for workflow-owned child tasks. */
export type ChildTaskContextPolicy = 'isolated'
/** Lifecycle mode for workflow-owned child tasks. */
export type ChildTaskMode = 'one_shot' | 'continuable'

/** Immutable content-free identity of one workflow-owned child task. */
export interface ChildTaskDescriptor {
	readonly id: string
	readonly parentRunId: string
	readonly sessionId: string
	readonly workflowId: string
	readonly workflowInvocationId: string
	readonly callId: string
	readonly agentId: string
	readonly modelAlias: string
	readonly contextPolicy: ChildTaskContextPolicy
	readonly mode: ChildTaskMode
	readonly createdAt: string
}

/** Content-free child-task lifecycle snapshot. */
export interface ChildTaskStatus {
	readonly descriptor: ChildTaskDescriptor
	readonly status: 'running' | 'succeeded' | 'failed' | 'cancelled'
	readonly finishedAt?: string
	readonly error?: import('../models/state.js').SerializedError
}

/** Handle for an isolated workflow-owned one-shot task. */
export interface ChildTaskHandle<Output> {
	readonly id: string
	result(): Promise<Output>
	status(): Promise<ChildTaskStatus>
	cancel(reason?: string): Promise<void>
}

/** Handle for an in-process child task with sequential turns. */
export interface ContinuableChildTaskHandle<Input, Output> extends ChildTaskHandle<Output> {
	send(input: Input): Promise<Output>
	close(): Promise<Output | undefined>
}

export type ChildTaskStartOptions<Groups extends readonly string[] = readonly []> = Readonly<{
	callId: string
	idempotencyKey?: string
	timeoutMs?: number
	context?: 'isolated'
	mode?: 'one_shot'
	sandbox?: SandboxPolicy<Groups[number]>
}>

export type ContinuableChildTaskStartOptions<Groups extends readonly string[] = readonly []> = Readonly<{
	callId: string
	timeoutMs?: number
	context?: 'isolated'
	mode: 'continuable'
	sandbox?: SandboxPolicy<Groups[number]>
}>

/** Definition-local workflow agent-call ceilings. */
export interface WorkflowAgentCallLimits {
	readonly maxCalls?: number
	readonly maxParallel?: number
}

export interface WorkflowChildTasks<Agents extends WorkflowAgentMap | undefined, ChildTaskSandboxGroups extends readonly string[] = readonly []> {
	start<K extends keyof NonNullable<Agents>>(
		agent: K,
		input: NonNullable<Agents>[K]['$infer']['input'],
		options: ContinuableChildTaskStartOptions<ChildTaskSandboxGroups>,
	): Promise<ContinuableChildTaskHandle<NonNullable<Agents>[K]['$infer']['input'], NonNullable<Agents>[K]['$infer']['output']>>
	start<K extends keyof NonNullable<Agents>>(
		agent: K,
		input: NonNullable<Agents>[K]['$infer']['input'],
		options: ChildTaskStartOptions<ChildTaskSandboxGroups>,
	): Promise<ChildTaskHandle<NonNullable<Agents>[K]['$infer']['output']>>
}

type WorkflowExternalWait<Durable extends true | undefined> = Durable extends true
	? Readonly<{ externalWait: Readonly<{ wait(request: ExternalWaitRequest): Promise<ExternalWaitResolved> }> }>
	: Readonly<Record<never, never>>

/** Typed handler context limited to the agents and models declared by a workflow. */
export type WorkflowContext<
	Input extends ModelSchema,
	Output extends ModelSchema,
	Agents extends WorkflowAgentMap | undefined,
	Models extends WorkflowModelMap | undefined,
	ChildTaskSandboxGroups extends readonly string[],
	Durable extends true | undefined,
> = Readonly<{
	readonly input: Infer<Input> & JsonValue
	readonly agents: WorkflowAgentInvokers<Agents>
	readonly models: WorkflowModelHandles<Models>
	readonly logger: Logger
	readonly telemetry: TelemetryShim
	readonly metrics: Metrics
	readonly signal: AbortSignal
	readonly runId: string
	readonly sessionId: string
	readonly metadata: Readonly<Record<string, JsonValue>>
	readonly step: <T extends JsonValue>(stepId: string, handler: () => Promise<T>, options?: DurableStepOptions) => Promise<T>
	readonly fanOut: <T, R>(items: readonly T[], worker: (item: T, index: number) => Promise<R>, options?: Readonly<{ concurrency?: number }>) => Promise<R[]>
	readonly childTasks: WorkflowChildTasks<Agents, ChildTaskSandboxGroups>
}> & WorkflowExternalWait<Durable>

/** Closed authoring fields for an application-orchestration workflow. */
export interface WorkflowOptions<
	Input extends ModelSchema,
	Output extends ModelSchema,
	Agents extends WorkflowAgentMap | undefined,
	Models extends WorkflowModelMap | undefined,
	ChildTaskSandboxGroups extends readonly string[],
	Workspace extends true | undefined,
	Durable extends true | undefined,
	Sandbox extends SandboxPolicy | undefined = undefined,
> {
	readonly input: Input
	readonly output: Output
	readonly description?: string
	readonly agents?: Agents
	readonly models?: Models
	readonly agentCalls?: WorkflowAgentCallLimits
	readonly childTaskSandboxGroups?: ChildTaskSandboxGroups
	readonly sandbox?: Sandbox
	readonly maxDepth?: number
	readonly workspace?: Workspace
	readonly durable?: Durable
	readonly handler: (context: WorkflowContext<Input, Output, Agents, Models, ChildTaskSandboxGroups, Durable>) => Promise<InferIn<Output>>
}

/** Frozen definition of one custom orchestration workflow. */
export type WorkflowDefinition<
	Id extends string,
	Input extends ModelSchema,
	Output extends ModelSchema,
	Agents extends WorkflowAgentMap | undefined = undefined,
	Models extends WorkflowModelMap | undefined = undefined,
	ChildTaskSandboxGroups extends readonly string[] = readonly [],
	Workspace extends true | undefined = undefined,
	Durable extends true | undefined = undefined,
	Sandbox extends SandboxPolicy | undefined = undefined,
> = Readonly<{
	kind: 'workflow'
	id: Id
	description?: string
	input: Input
	output: Output
	agentCalls?: WorkflowAgentCallLimits
	childTaskSandboxGroups?: ChildTaskSandboxGroups
	maxDepth?: number
	handler: WorkflowOptions<Input, Output, Agents, Models, ChildTaskSandboxGroups, Workspace, Durable, Sandbox>['handler']
	contract: HarnessTargetContract<'workflow', Id, Input, Output, 'none', readonly ['tool-approval', 'external-wait']>
	readonly $infer: DefinitionInference<Input, Output>
}> & PresentField<'agents', Agents> & PresentField<'models', Models>
	& PresentField<'childTaskSandboxGroups', ChildTaskSandboxGroups extends readonly [] ? undefined : ChildTaskSandboxGroups>
	& PresentField<'workspace', Workspace> & PresentField<'durable', Durable>
	& PresentField<'sandbox', Sandbox>
	& DefinitionReference<'workflow', Id>

/** Identity-bearing workflow shape accepted by catalogs and Harness composition. */
export type AnyWorkflowDefinition = Readonly<{
	kind: 'workflow'
	id: string
	description?: string | undefined
	input: ModelSchema
	output: ModelSchema
	agents?: WorkflowAgentMap | undefined
	models?: WorkflowModelMap | undefined
	agentCalls?: WorkflowAgentCallLimits | undefined
	childTaskSandboxGroups?: readonly string[] | undefined
	sandbox?: SandboxPolicy | undefined
	maxDepth?: number | undefined
	workspace?: true | undefined
	durable?: true | undefined
	handler: (...args: any[]) => Promise<any>
	contract: HarnessTargetContract<'workflow', string, ModelSchema, ModelSchema, 'none', readonly ['tool-approval', 'external-wait']>
	readonly $infer: { readonly input: any; readonly validatedInput: any; readonly output: any }
}> & DefinitionReference<'workflow', string>
