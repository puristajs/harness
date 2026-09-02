import { z } from 'zod'
import { JsonLogger, type Logger } from '../logger/index.js'
import type {
	Embedding,
	EmbeddingRequest,
	EmbeddingResponse,
	ModelAlias,
	ModelCapability,
	ModelDefaults,
	ModelFeatureSet,
	ModelProviderInfo,
	ModelProvider,
	ObjectRequest,
	ObjectResponse,
	ObjectStreamChunk,
	OutputMode,
	ContentPartKind,
	RerankDocument,
	RerankRequest,
	RerankResponse,
	RerankResult,
	TextRequest,
	TextResponse,
	TextStreamChunk,
	ToolCallSpec,
	ModelMessage,
	ModelToolSpec,
	TokenUsage,
	FinishReason,
	ContentPart,
	ModelCallOptions,
} from '../ports/model-provider.js'
import { validateHarnessStorage, type HarnessStorage } from '../storage/types.js'
import type { Metrics, TelemetryShim } from '../telemetry/index.js'
import type { HarnessAdapterContext } from '../ports/harness-context.js'
import { inMemoryMemoryEngine } from '../memory/in-memory.js'
import type {
	MemoryConfiguration,
	MemoryEngine,
	MemoryFacade,
	MemoryModelReferences,
	SessionMemory,
} from '../ports/memory.js'
import { validateMemoryEngine } from '../ports/memory.js'
import type { DurableWorkspacePolicy, DurableWorkspace } from '../ports/workspace.js'
import { validateDurableWorkspace } from '../ports/workspace.js'
import type { ExternalWaitOutcome, ExternalWaitRequest, ExternalWaitResolved } from '../storage/external-wait.js'
import { InMemoryHarnessStorage } from '../storage/in-memory.js'
import type { JsonValue } from '../models/json.js'
import type { Message } from '../models/state.js'
import { validateModelRetrySetting } from '../models/retry-policy.js'
import type { RunStatus } from '../models/state.js'
import type { HarnessError } from '../errors/harness-error.js'
import { HarnessConfigError, SkillManifestError, ValidationError } from '../errors/catalog.js'
import { BUILTIN_TOOL_NAMES, resolveEnabledBuiltinTools } from '../tools/index.js'
import {
	agentExecutionRequirementsSchema,
	compileAgentExecutionRequirements,
	type AgentExecutionRequirementDeclaration,
	type AgentExecutionRequirements,
} from './agent-requirements.js'
import { hasModelCapabilities } from '../models/registry.js'
import { autoDetectSandbox, type Sandbox, type SandboxSessionFor } from '../sandbox/index.js'
import { createSessionHarness } from '../sessions/index.js'
import type { ModelHandle } from '../models/registry.js'
import {
	hasAdapterCapabilities,
	missingCapabilities,
	uniqueCapabilities,
	type AdapterCapability,
	type AdapterInspection,
	type HarnessInspection,
	type HarnessModuleInspection,
} from '../ports/capabilities.js'
import type { DurableStepOptions } from '../runtime/steps.js'
import { type ContextProjectionPolicy, validateContextProjection } from '../context-projection.js'
import { type SessionHistoryRetentionPolicy, validateSessionHistoryRetention } from '../sessions/history-retention.js'
import type { HarnessIdentity } from '../identity/index.js'
import {
	sandboxBindingOptionsSchema,
	type SandboxBindingOptions,
	type SandboxPolicy,
	type SessionOptions,
} from '../sandbox/ownership.js'
import type { DecisionExecutionContext } from '../decisions/types.js'
import { agentPermissionsSchema, governanceConfigSchema } from '../decisions/schemas.js'
import { validateToolDefinitions } from './tool-definition.js'
import type { Infer, InferIn, ModelSchema, Schema } from '../schema/index.js'
import { projectModelSchema } from '../schema/json-schema.js'

/**
 * Statically JSON-compatible validated value. `undefined` is allowed only to
 * represent omitted optional object properties in TypeScript; runtime boundary
 * validation still requires strict JSON before persistence or provider calls.
 */
type JsonCompatible =
	| null
	| boolean
	| number
	| string
	| undefined
	| readonly JsonCompatible[]
	| { readonly [key: string]: JsonCompatible }

/** @inline Internal existential forms used to retain vendor-specific schema inference. */
type AnySchema = Schema<any, any>
/** @inline Internal existential form for schemas that can be projected to model JSON Schema. */
type AnyModelSchema = ModelSchema<any, any>
/** Declaration-only fallback when an agent or workflow omits a schema. */
type DefaultSchema = Schema<string, string>
/** Declaration-only model-capable fallback for default-loop agent output. */
type DefaultModelSchema = ModelSchema<string, string>

/** Rejects schemas whose validated value cannot cross a JSON Harness boundary. */
type JsonOutputSchema<S extends AnySchema> = Infer<S> extends JsonCompatible ? S : never

/** Compile-time proof that a validated schema value is JSON-compatible. */
type JsonSchemaConstraint<S extends AnySchema> = Infer<S> extends JsonCompatible ? unknown : never

type CompiledModelSchemas = {
	readonly agentOutputs: Readonly<Record<string, JsonValue>>
	readonly toolInputs: Readonly<Record<string, JsonValue>>
}

/** Stable harness version string for diagnostics and generated documentation. */
export { HARNESS_VERSION } from '../version.js'

/** OpenTelemetry capture controls used by the harness. */
export type TelemetryFlavor = 'dual' | 'gen_ai_only' | 'openinference_only'
export type ContentCaptureMode = 'NO_CONTENT' | 'SPAN_ONLY' | 'EVENT_ONLY' | 'SPAN_AND_EVENT'

export interface TelemetryOptions {
	/** Backend emission shape. */
	flavor?: TelemetryFlavor
	/** Span/event content capture mode. */
	contentCaptureMode?: ContentCaptureMode
}

/** Default harness budgets and execution behavior. */
export interface HarnessDefaults {
	/**
	 * Default maximum iterations for the built-in agent loop. Default: `16`.
	 * Must be a positive integer; explicit values are not otherwise capped.
	 */
	agentMaxIterations?: number
	/** Per-run timeout in milliseconds. `0` disables. Default: `600_000`. */
	runTimeoutMs?: number
	/** Per-tool timeout in milliseconds. Default: `120_000`. */
	toolTimeoutMs?: number
	/** Per-decision callback timeout in milliseconds. Default: `10_000`. */
	decisionTimeoutMs?: number
	/** Per-skill timeout in milliseconds. Default: `60_000`. */
	skillTimeoutMs?: number
	/** Per-model timeout in milliseconds. Default: `300_000`. */
	modelTimeoutMs?: number
	/** Maximum tool calls from one model response executed at the same time. Default: `8`. */
	maxParallelToolCalls?: number
	/**
	 * Max non-system messages forwarded into model calls.
	 * `undefined` keeps all history, `0` keeps only system messages.
	 */
	historyWindow?: number
	/** Optional retry-only transient context projection. */
	contextProjection?: ContextProjectionPolicy
	/**
	 * Optional durable conversation-history bounds for every session.
	 *
	 * This is storage retention, not a model context-window setting. It retains
	 * complete newest turns and counts UTF-8 serialized bytes; model token
	 * budgeting requires an explicit model/provider token counter.
	 */
	historyRetention?: SessionHistoryRetentionPolicy
	/** Default workflow child-agent delegation budgets. */
	delegation?: DelegationDefaults
}

/** Workflow child-agent delegation defaults. Delegation is disabled unless explicitly enabled. */
export interface DelegationDefaults {
	/**
	 * Enable workflow child-agent calls for workflows that do not declare their
	 * own `delegation` policy. Default: `false`.
	 */
	enabled?: boolean
	/**
	 * Maximum child-agent calls one workflow run may start. Default: `32`.
	 * Set per workflow with `workflow.delegation.maxChildAgentCalls`.
	 */
	maxChildAgentCalls?: number
	/**
	 * Maximum child-agent calls active at the same time inside one workflow run.
	 * Default: `8`.
	 */
	maxParallelChildAgentCalls?: number
	/**
	 * Maximum local delegation depth. Default: `1`.
	 * Current harness workflows invoke leaf agents, so `1` allows normal
	 * workflow-to-agent calls and `0` disables child-agent delegation.
	 */
	maxDepth?: number
}

/** Top-level harness options passed to {@link defineHarness}. */
export interface HarnessOptions {
	/** Optional harness name for logs, telemetry, and diagnostics. Default: `agent-harness`. */
	name?: string
}

/** Durable execution opt-in for a single workflow call. */
export interface DurableInvokeOptions {
	/** Stable run id reused across resumes/retries. Matches `/^[A-Za-z0-9_.:-]{1,200}$/`. */
	runId: string
	/** Worker/process id owning the durable lease. Defaults to the harness worker id. */
	workerId?: string
	/** Initial durable step id label. Defaults to the workflow id. */
	stepId?: string
	/** Optional attempt hint; the runtime may raise it on retry. */
	attempt?: number
	/**
	 * Per-run workspace constraints applied when this invocation creates its
	 * durable workspace. Adapters remain responsible for rejecting policies
	 * they cannot enforce. This changes workspace retention/storage limits only;
	 * it never grants access to another adapter or sandbox capability.
	 */
	workspacePolicy?: Partial<DurableWorkspacePolicy>
}

/** Shared invoke options for workflow and agent execution. */
export interface InvokeOptions {
	/** Abort signal used to cooperatively cancel the call. */
	signal?: AbortSignal
	/**
	 * Opaque, run-scoped context supplied by a host integration. It is available
	 * only to bound host tools and is never persisted, logged, or sent to a model.
	 */
	hostContext?: unknown
	/** Optional timeout override in milliseconds. `0` disables. */
	timeoutMs?: number
	/** Optional history-window override for this call only. */
	historyWindow?: number
	/**
	 * Stable caller-owned key for at-least-once delivery of a direct agent call.
	 * Repeating a successful call with the same session, agent, input, and key
	 * returns the recorded output without invoking the model or writing another
	 * transcript turn. It is intentionally not inferred from prompt content.
	 */
	idempotencyKey?: string
	/** Optional retry-only context projection override. */
	contextProjection?: ContextProjectionPolicy
	/** Optional W3C Trace Context parent. */
	traceparent?: string
	/** Optional W3C Trace Context state. */
	tracestate?: string
	/** Scalar metadata exposed to handlers and telemetry sanitizers. */
	metadata?: Record<string, JsonValue>
	/**
	 * Opt a workflow run into durable execution against the configured
	 * `.storage(...)` (and optional `.workspace(...)`). Workflow-only;
	 * supplying it on an agent run throws `ValidationError`.
	 */
	durable?: DurableInvokeOptions
}

/** Canonical built-in tool names provided by the harness. */
export type BuiltinToolName = 'bash' | 'read' | 'write' | 'edit' | 'glob' | 'grep' | 'list'

/** Permission modes for sandbox-mutating tools. */
export type PermissionMode = Extract<z.infer<typeof import('../decisions/schemas.js').permissionPolicySchema>, string>

/** Structured permission policy for a single tool family. */
export type PermissionPolicy = Exclude<z.infer<typeof import('../decisions/schemas.js').permissionPolicySchema>, string>

/** Per-agent permission configuration for built-in mutating tools. */
export type AgentPermissions = z.infer<typeof agentPermissionsSchema>

/** Skill frontmatter parsed from `SKILL.md`. */
export interface SkillFrontmatter {
	name: string
	description: string
	license?: string
	compatibility?: string
	metadata?: Record<string, string>
	'allowed-tools'?: string
}

/** Validation mode for `SKILL.md` frontmatter. */
export type SkillValidationMode = 'strict' | 'lenient'

/** Diagnostic produced while parsing or discovering skills. */
export interface SkillDiagnostic {
	level: 'warn' | 'error'
	code:
		| 'missing_skill_md'
		| 'invalid_frontmatter'
		| 'missing_description'
		| 'invalid_name'
		| 'name_mismatch'
		| 'directory_missing'
		| 'collision_shadowed'
		| 'untrusted_project_skill'
		| 'scan_limit_reached'
	message: string
	skillName?: string
	directory?: string
	source?: string
}

/** Mounted skill metadata after frontmatter parsing. */
export interface ResolvedSkill {
	/** Public skill id. */
	name: string
	/** Short user-facing description from frontmatter. */
	description: string
	/** Absolute directory mounted into `/skills/<name>`. */
	directory: string
	/** Absolute path to the parsed `SKILL.md`. */
	skillPath: string
	/** Absolute path exposed as the skill instruction file location. */
	location: string
	/** Sandbox mount path for this skill. */
	mountPath: `/skills/${string}`
	license?: string
	compatibility?: string
	metadata?: Record<string, string>
	allowedTools?: string
	trust: 'trusted' | 'project' | 'user'
	source?: string
	diagnostics: readonly SkillDiagnostic[]
}

/** Conversation history accessor for a single session thread. */
export interface ConversationHistory {
	/** Returns persisted conversation messages for the session. */
	list(opts?: { limit?: number; before?: string }): Promise<Message[]>
}

/** @inline */
type ToolHandlerContextBase = {
	/** Cancellation signal for the current tool invocation. */
	signal: AbortSignal
	/** Immutable metadata supplied for the current agent or workflow invocation. */
	metadata: Readonly<Record<string, JsonValue>>
	/** Sandbox attachment for the current run. */
	sandbox: import('../sandbox/index.js').SandboxSessionBase
	/** Logger scoped to the invocation. */
	logger: Logger
	/** Harness telemetry helpers. */
	telemetry: TelemetryShim
	/** Harness metrics helpers. */
	metrics: Metrics
	/** Memory operations available to this invocation. */
	memory: MemoryFacade
	/** Current run identifier. */
	runId: string
	/** Current session identifier. */
	sessionId: string
	/** Agent invoking the tool. */
	agentId: string
	/** Tool alias registered with the Harness. */
	toolId: string
}

/**
 * Context provided to custom tools, including the current sandbox attachment.
 *
 * Register `.sandbox(adapter)` before `.tool(...)` or `.tools(...)` to infer supported sandbox
 * operations in inline handlers. Without a precise capability tuple, `sandbox`
 * exposes file operations; use the sandbox capability guards before exec or spawn.
 *
 * @typeParam C - Capability tuple of the sandbox registered on the builder.
 * @example
 * ```ts
 * type ShellToolContext = ToolHandlerContext<readonly ['sandbox.fs', 'sandbox.exec']>
 * ```
 */
export type ToolHandlerContext<C extends readonly AdapterCapability[] = readonly AdapterCapability[]> =
	number extends C['length']
		? ToolHandlerContextBase
		: Omit<ToolHandlerContextBase, 'sandbox'> & { sandbox: SandboxSessionFor<C> }

/** TypeScript-native tool definition. */
export interface TsToolDefinition<
	I extends AnyModelSchema = AnyModelSchema,
	O extends AnySchema = AnySchema,
	C extends ToolContextShape = ToolHandlerContext,
> {
	/** Tool kind discriminator. Defaults to `ts`. */
	kind?: 'ts'
	/** Short model-facing description. */
	description: string
	/** Input schema validated before handler invocation. */
	input: I & JsonOutputSchema<I>
	/** Output schema validated after handler invocation. */
	output: O & JsonOutputSchema<O>
	/** Async tool implementation running inside the current session sandbox. */
	handler: (ctx: C, input: Infer<I>) => Promise<InferIn<O>>
	/** Optional adapter hook for inheriting harness logger, telemetry, and defaults. */
	configureHarnessContext?: (context: HarnessAdapterContext) => void
}

/** Provider-neutral contract for a tool implemented by the embedding host. */
export interface HostToolDefinition<I extends AnyModelSchema = AnyModelSchema, O extends AnySchema = AnySchema> {
	/** Host tools have no definition-time handler. */
	kind: 'host'
	/** Short model-facing description. */
	description: string
	/** Input schema validated before the host binding is called. */
	input: I & JsonOutputSchema<I>
	/** Output schema validated after the host binding returns. */
	output: O & JsonOutputSchema<O>
}

/** Context passed to a host-tool binding for the active run. */
export type HostToolHandlerContext<Host = unknown> = ToolHandlerContext & { readonly host: Host }

/** Runtime implementation of one provider-neutral host-tool contract. */
export type HostToolBinding<
	I extends AnyModelSchema = AnyModelSchema,
	O extends AnySchema = AnySchema,
	Host = unknown,
> = (context: HostToolHandlerContext<Host>, input: Infer<I>) => Promise<InferIn<O>>

/**
 * Content-free origin metadata for an MCP tool projected from an Agent Plugin.
 *
 * The harness attaches this metadata to normal MCP tool spans and metrics; it
 * never emits package paths, commands, URLs, headers, inputs, or results.
 */
export interface McpPluginProvenance {
	/** Validated plugin manifest name. */
	name: string
	/** Declared plugin version, when the manifest supplied one. */
	version?: string
	/** Reviewed SHA-256 package digest. */
	digest: string
	/** Component category; MCP is the only category valid for MCP tools. */
	component: 'mcp'
}

/** MCP-over-stdio tool definition. */
export interface McpStdioToolDefinition {
	kind: 'mcp_stdio'
	description: string
	command: string
	args?: readonly string[]
	/** Working directory inside the current sandbox. */
	cwd?: string
	env?: Record<string, string>
	/** Prepares a sandbox-local launch before the MCP process is spawned. */
	prepareLaunch?: (context: {
		sandbox: import('../sandbox/index.js').SandboxSessionBase
		signal?: AbortSignal
	}) => Promise<{
		command?: string
		args?: readonly string[]
		cwd?: string
		env?: Record<string, string>
		cleanup?: () => Promise<void>
	}>
	/** Optional bootstrap command executed inside the sandbox before the MCP server is called. */
	install?: {
		command: string
		cwd?: string
		env?: Record<string, string>
		timeoutMs?: number
	}
	tool: string
	/** Optional content-free Agent Plugin origin metadata for telemetry. */
	provenance?: McpPluginProvenance
	inputAdapter?: (input: unknown) => unknown
	outputAdapter?: (output: unknown) => unknown
	configureHarnessContext?: (context: HarnessAdapterContext) => void
}

/** Supported MCP auth kinds. */
export type McpAuth =
	/** No authentication. */
	| { kind: 'none' }
	/** Bearer token authentication. */
	| { kind: 'bearer'; token: string }
	/** OAuth2 access token authentication. */
	| { kind: 'oauth2'; accessToken: string }
	/** API key authentication. */
	| { kind: 'api_key'; header: string; value: string }
	/** Basic authentication. */
	| { kind: 'basic'; username: string; password: string }

/** MCP-over-HTTP tool definition. */
export interface McpHttpToolDefinition {
	kind: 'mcp_http'
	description: string
	url: string
	tool: string
	auth?: McpAuth
	headers?: Record<string, string>
	/** Fetch redirect policy. Agent Plugin bindings use `error` to prevent cross-origin header forwarding. */
	redirect?: 'error' | 'follow' | 'manual'
	/** Optional content-free Agent Plugin origin metadata for telemetry. */
	provenance?: McpPluginProvenance
	inputAdapter?: (input: unknown) => unknown
	outputAdapter?: (output: unknown) => unknown
	configureHarnessContext?: (context: HarnessAdapterContext) => void
}

/** @inline */
type ToolContextShape = Omit<ToolHandlerContext, 'sandbox'> & {
	sandbox: import('../sandbox/index.js').SandboxSessionBase
}

/** Runtime union of native and MCP tool definitions. */
export type ToolDefinition<C extends ToolContextShape = ToolHandlerContext> =
	| TsToolDefinition<AnyModelSchema, AnySchema, C>
	| McpStdioToolDefinition
	| McpHttpToolDefinition

/** Definition-time union including contracts that require a runtime host binding. */
export type AuthoredToolDefinition<C extends ToolContextShape = ToolHandlerContext> =
	| ToolDefinition<C>
	| HostToolDefinition

/** Full provider-neutral tool registry shape. */
export type AuthoredToolsConfig<C extends ToolContextShape = ToolHandlerContext> = Record<
	string,
	AuthoredToolDefinition<C>
>

type NativeToolSchemaFields = {
	kind?: 'ts'
	input: AnyModelSchema
	output: AnySchema
}

type ToolSchemaFields = NativeToolSchemaFields | McpStdioToolDefinition | McpHttpToolDefinition

type ToolDefinitionFor<C extends ToolContextShape, D> = D extends McpStdioToolDefinition
	? McpStdioToolDefinition
	: D extends McpHttpToolDefinition
		? McpHttpToolDefinition
		: D extends { input: infer I extends AnyModelSchema; output: infer O extends AnySchema }
			? TsToolDefinition<I, O, C>
			: never

type NativeToolsConfigFromSchemaMaps<
	C extends ToolContextShape,
	T extends Record<string, { input: AnyModelSchema; output: AnySchema }>,
> = {
	[K in keyof T]: TsToolDefinition<T[K]['input'], T[K]['output'], C>
}

type ToolsConfigFromSchemaMaps<C extends ToolContextShape, T extends Record<string, ToolSchemaFields>> = {
	[K in keyof T]: T[K] & ToolDefinitionFor<C, T[K]>
}

/** Full authored and resolved tool registry shape accepted by `.tools(...)`. */
export type ToolsConfig<C extends ToolContextShape = ToolHandlerContext> = Record<string, ToolDefinition<C>>

/** Compiles the immutable JSON Schema payloads consumed by model providers. */
function compileModelSchemas<C extends ToolContextShape>(
	agents: Readonly<Record<string, AnyAgentDefinition>>,
	tools: Readonly<ToolsConfig<C>>,
): CompiledModelSchemas {
	const agentOutputs: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>
	const toolInputs: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>

	for (const [id, agent] of Object.entries(agents)) {
		if (agent.handler) continue
		agentOutputs[id] = projectModelSchema((agent.output ?? z.string()) as AnyModelSchema, 'agent_output', id)
	}
	for (const [id, tool] of Object.entries(tools)) {
		if (!('input' in tool) || !('handler' in tool) || typeof tool.handler !== 'function') continue
		toolInputs[id] = projectModelSchema(tool.input as AnyModelSchema, 'tool_input', id)
	}

	return Object.freeze({
		agentOutputs: Object.freeze(agentOutputs),
		toolInputs: Object.freeze(toolInputs),
	})
}

/** Skill definition registered on the harness builder. */
export interface SkillDefinition {
	/** Absolute path to the directory containing `SKILL.md`. */
	directory: string
	validationMode?: SkillValidationMode
	trust?: 'trusted' | 'project' | 'user'
	source?: string
}

/** Full skill registry shape. */
export type SkillsConfig = Record<string, SkillDefinition>

/** Options for local Agent Skills discovery. */
export interface DiscoverSkillsOptions {
	projectRoot?: string
	clientName?: string
	includeProjectAgentsDir?: boolean
	includeProjectClientDir?: boolean
	includeUserAgentsDir?: boolean
	includeUserClientDir?: boolean
	includeClaudeCompatDir?: boolean
	includeAncestorProjectDirs?: boolean
	trustedProjectRoots?: readonly string[]
	validationMode?: SkillValidationMode
	maxDepth?: number
	maxDirectories?: number
}

/** Result of local Agent Skills discovery. */
export interface DiscoveredSkills {
	skills: SkillsConfig
	diagnostics: readonly SkillDiagnostic[]
}

/** Alias map passed to `.models(...)`. */
export type ModelsConfig = Record<string, ModelAlias>

/** Provider-neutral model requirement stored in a portable Harness definition. */
export interface ModelRequirement {
	/** Capabilities required by definitions that reference this alias. */
	readonly capabilities: readonly ModelCapability[]
}

/** Model shapes used for definition-time capability inference. */
export type ModelTypesConfig = Record<string, ModelRequirement>

type RequiredModelTypes<R extends ModelTypesConfig> = {
	readonly [K in keyof R]: R[K] & ModelAlias
}

/** Builder-state accumulator used for type propagation across the fluent harness builder. */
export interface BuilderState {
	models?: ModelsConfig
	tools?: AuthoredToolsConfig<never>
	/** Capability tuple of the explicitly configured sandbox, propagated to tool handlers. */
	sandboxCapabilities?: readonly AdapterCapability[]
	/** Literal sandbox-sharing groups declared with the configured sandbox. */
	sandboxGroups?: readonly string[]
	skills?: SkillsConfig
	agents?: Record<string, AnyAgentDefinition>
	workflows?: Record<string, WorkflowDefinition<any, AnySchema, AnySchema>>
}

/** @inline */
type SandboxCapabilitiesFor<S extends BuilderState> = S extends {
	sandboxCapabilities: infer C extends readonly AdapterCapability[]
}
	? C
	: readonly AdapterCapability[]

/** Literal groups declared at the composition root. */
export type ConfiguredSandboxGroups<S extends BuilderState> = S extends {
	sandboxGroups: infer G extends readonly string[]
}
	? G[number]
	: never

type ToolContextFor<S extends BuilderState> = ToolHandlerContext<SandboxCapabilitiesFor<S>>

type SchemaInputOrString<T> = T extends AnySchema ? InferIn<T> : string

type SchemaOutputOrString<T> = T extends AnySchema ? Infer<T> : string

type DefinitionInput<D> = D extends { input: infer I }
	? SchemaInputOrString<I>
	: D extends { input?: infer I }
		? SchemaInputOrString<I>
		: string

type DefinitionOutput<D> = D extends { output: infer O }
	? SchemaOutputOrString<O>
	: D extends { output?: infer O }
		? SchemaOutputOrString<O>
		: string

/** Helper to infer workflow input type from a workflow definition. */
export type WorkflowInput<S extends BuilderState, K extends keyof NonNullable<S['workflows']>> = DefinitionInput<
	NonNullable<S['workflows']>[K]
>

/** Helper to infer workflow output type from a workflow definition. */
export type WorkflowOutput<S extends BuilderState, K extends keyof NonNullable<S['workflows']>> = DefinitionOutput<
	NonNullable<S['workflows']>[K]
>

/** Helper to infer agent input type from an agent definition. */
export type AgentInput<S extends BuilderState, K extends keyof NonNullable<S['agents']>> = DefinitionInput<
	NonNullable<S['agents']>[K]
>

/** Helper to infer agent output type from an agent definition. */
export type AgentOutput<S extends BuilderState, K extends keyof NonNullable<S['agents']>> = DefinitionOutput<
	NonNullable<S['agents']>[K]
>

/** Helper to infer custom TypeScript tool input from the configured Standard Schema. */
export type ToolInput<S extends BuilderState, K extends keyof NonNullable<S['tools']> & string> =
	NonNullable<S['tools']>[K] extends TsToolDefinition<infer I, AnySchema, infer _C>
		? Infer<I>
		: NonNullable<S['tools']>[K] extends HostToolDefinition<infer I, AnySchema>
			? Infer<I>
			: JsonValue

/** Capability-filtered model handles keyed by configured model alias. */
export type ModelHandles<S extends BuilderState> = {
	readonly [K in keyof NonNullable<S['models']>]: NonNullable<S['models']>[K] extends {
		capabilities: readonly ModelCapability[]
	}
		? ModelHandle<NonNullable<S['models']>[K]>
		: never
}

/** Minimal context available when deriving dynamic agent instructions. */
export interface AgentContextMinimal<S extends BuilderState, I> {
	input: I
	sessionId: string
	runId: string
	history: ConversationHistory
	memory: MemoryFacade
	metadata: Readonly<Record<string, JsonValue>>
	metrics: Metrics
}

/** Context passed before each default agent loop model call. */
export interface AgentPrepareStepContext<S extends BuilderState, I> extends AgentContextMinimal<S, I> {
	/** Zero-based model-call step in the default loop. */
	step: number
	/** Model alias selected for this step before overrides are applied. */
	model: keyof NonNullable<S['models']> & string
	/** Messages that would be sent to the model for this step. */
	messages: readonly ModelMessage[]
	/** Model-facing tools that would be available for this step. */
	tools: readonly ModelToolSpec[]
}

/** Per-step overrides returned from `AgentDefinition.prepareStep`. */
export interface AgentPrepareStepResult<S extends BuilderState> {
	/** Optional model alias override for this model call. */
	model?: keyof NonNullable<S['models']> & string
	/** Optional instruction override for this model call only. */
	instructions?: string
	/** Optional model-facing tool names to keep active for this model call. */
	activeTools?: readonly string[]
	/** Optional message override for this model call only. */
	messages?: readonly ModelMessage[]
	/** Optional generation settings for this model call only. */
	call?: ModelCallOptions
}

/** Context passed after a default agent loop model call to decide whether to stop. */
export interface AgentStopWhenContext<S extends BuilderState, I> extends AgentPrepareStepContext<S, I> {
	/** Raw provider-normalized object response from the current model call. */
	response: ObjectResponse<JsonValue>
	/** Tool calls requested by the current model response. */
	toolCalls: readonly ToolCallSpec[]
}

/** Hook used to prepare each model call in the default agent loop. */
export type AgentPrepareStep<S extends BuilderState, I> = (
	ctx: AgentPrepareStepContext<S, I>,
) => AgentPrepareStepResult<S> | Promise<AgentPrepareStepResult<S> | void> | void

/** Hook used to stop the default loop after a model call. */
export type AgentStopWhen<S extends BuilderState, I> = (ctx: AgentStopWhenContext<S, I>) => boolean | Promise<boolean>

/** A model request after agent preparation and governance tool exposure. */
export interface AgentModelRequest {
	/** Complete model-visible message list, including the reconstructed system message. */
	messages: readonly ModelMessage[]
	/** Model-visible tools for this loop iteration. */
	tools: readonly ModelToolSpec[]
	/** JSON Schema used to validate the final object response. */
	schema: JsonValue
	/** Optional provider-neutral generation options. */
	call?: ModelCallOptions
}

/** Content-free context common to every default-loop interceptor hook. */
export interface AgentExecutionInterceptorContext<S extends BuilderState, I>
	extends Omit<AgentContextMinimal<S, I>, 'input'> {
	/** Parsed agent input for the invocation. */
	agentInput: I
	/** Stable interceptor id registered on the agent definition. */
	interceptorId: string
	/** Runtime-owned occurrence id: the delegated call id, or the direct run id. */
	invocationId: string
	/** Current default-loop model step. `0` for input validation hooks. */
	step: number
	/** Model alias selected for the current model step, when applicable. */
	model?: keyof NonNullable<S['models']> & string
	/** Current agent id. */
	agentId: string
	/** Current workflow id when this agent is invoked by a workflow. */
	workflowId?: string
	/** Harness-scoped model handles. */
	models: ModelHandles<S>
	/** Cooperative cancellation signal for this invocation. */
	signal: AbortSignal
	/**
	 * Bounded lifecycle for the current interceptor decision.
	 * Interceptors that invoke nested decision callbacks must forward this exact
	 * context so tool and run cancellation retain their original identity.
	 */
	decision: DecisionExecutionContext
	/** Harness logger; interceptor implementations must keep content out of logs by default. */
	logger: Logger
	/** Harness telemetry shim; interceptor implementations must use content-free attributes by default. */
	telemetry: TelemetryShim
}

/** A content-free allow or block result from one default-loop interceptor. */
export type AgentInterceptorDecision = z.infer<typeof import('../decisions/schemas.js').decisionResultSchema>

/** A content-free phase-specific replacement from one default-loop interceptor. */
export type AgentInterceptorTransform<T> = Omit<AgentInterceptorDecision, 'decision'> & {
	decision: 'transform'
	value: T
}

/** Allow, block, or replace the value owned by one default-loop interception point. */
export type AgentExecutionInterception<T> = AgentInterceptorDecision | AgentInterceptorTransform<T>

/** Input gate invoked after the agent input schema has parsed and before any handler or model work. */
export interface AgentBeforeInputInterceptorContext<S extends BuilderState, I>
	extends AgentExecutionInterceptorContext<S, I> {
	input: I
}

/** Model gate invoked after `prepareStep` and tool exposure, immediately before a provider call. */
export interface AgentBeforeModelInterceptorContext<S extends BuilderState, I>
	extends AgentExecutionInterceptorContext<S, I> {
	request: AgentModelRequest
}

/** Model gate invoked immediately after a provider response and before run events, output validation, or tool dispatch. */
export interface AgentAfterModelInterceptorContext<S extends BuilderState, I>
	extends AgentExecutionInterceptorContext<S, I> {
	request: AgentModelRequest
	response: ObjectResponse<JsonValue>
}

/** Tool gate invoked before permission/governance evaluation and before the tool side effect. */
export interface AgentBeforeToolInterceptorContext<S extends BuilderState, I>
	extends AgentExecutionInterceptorContext<S, I> {
	toolId: string
	callId: string
	input: JsonValue
}

/** Tool gate invoked after the tool completes and validates, before its result is emitted or returned to the model. */
export interface AgentAfterToolInterceptorContext<S extends BuilderState, I>
	extends AgentExecutionInterceptorContext<S, I> {
	toolId: string
	callId: string
	output: JsonValue
}

/** Final-output gate invoked before final output validation, persistence, or delivery. */
export interface AgentBeforeOutputInterceptorContext<S extends BuilderState, I>
	extends AgentExecutionInterceptorContext<S, I> {
	output: JsonValue
}

/**
 * Provider-neutral interception points for the built-in agent loop.
 *
 * Interceptors are ordered and fail closed: a block or hook failure ends the
 * invocation before the guarded operation can continue. They deliberately do
 * not apply to a custom `AgentDefinition.handler`, which owns its own model and
 * tool lifecycle.
 */
export interface AgentExecutionInterceptor<S extends BuilderState = BuilderState, I = JsonValue> {
	/** Stable, content-free identifier used in errors and telemetry. */
	id: string
	/**
	 * Tool and model declarations checked against the completed registry during
	 * `.build()`. Requirements only validate configuration; they cannot widen
	 * an agent's runtime permissions or activate a disabled tool.
	 */
	requirements?: AgentExecutionRequirements
	beforeInput?: (
		ctx: AgentBeforeInputInterceptorContext<S, I>,
	) => AgentExecutionInterception<JsonValue> | void | Promise<AgentExecutionInterception<JsonValue> | void>
	beforeModel?: (
		ctx: AgentBeforeModelInterceptorContext<S, I>,
	) =>
		| AgentExecutionInterception<{ messages: readonly ModelMessage[] }>
		| void
		| Promise<AgentExecutionInterception<{ messages: readonly ModelMessage[] }> | void>
	afterModel?: (
		ctx: AgentAfterModelInterceptorContext<S, I>,
	) => AgentInterceptorDecision | void | Promise<AgentInterceptorDecision | void>
	beforeTool?: (
		ctx: AgentBeforeToolInterceptorContext<S, I>,
	) => AgentExecutionInterception<JsonValue> | void | Promise<AgentExecutionInterception<JsonValue> | void>
	afterTool?: (
		ctx: AgentAfterToolInterceptorContext<S, I>,
	) => AgentExecutionInterception<JsonValue> | void | Promise<AgentExecutionInterception<JsonValue> | void>
	beforeOutput?: (
		ctx: AgentBeforeOutputInterceptorContext<S, I>,
	) => AgentExecutionInterception<JsonValue> | void | Promise<AgentExecutionInterception<JsonValue> | void>
}

/**
 * Opaque integration key used by optional Guardrails implementations.
 *
 * Applications do not read this property directly. Pass a compatible binding
 * to the `guardrails` field of a default-loop agent definition; the builder
 * resolves it into the interceptor chain without importing an optional addon.
 */
export const agentGuardrailsBinding = Symbol('@purista/harness/agent-guardrails-binding')

/**
 * Provider-neutral binding implemented by an optional Guardrails package.
 *
 * The binding can validate requirements but cannot register models, enable
 * tools, or widen an agent's permissions.
 */
export interface AgentGuardrailsBinding {
	readonly [agentGuardrailsBinding]: AgentExecutionInterceptor
}

/** Governance mode for policy evaluation. `shadow` records decisions without enforcement. */
export type GovernanceMode = NonNullable<z.infer<typeof governanceConfigSchema>['mode']>

/** Policy effects supported by the built-in governance evaluator. */
export type GovernanceEffect = GovernanceDecision['effect']

/** Policy decision for model-facing tool exposure before a model step. */
export type GovernanceExposureEffect = NonNullable<
	NonNullable<z.infer<typeof governanceConfigSchema>['exposure']>['defaultEffect']
>

/** Tool ids policy rules may target. Includes configured custom tools and built-in tools. */
export type GovernanceToolId<S extends BuilderState> = (keyof NonNullable<S['tools']> & string) | BuiltinToolName

type GovernanceToolInput<S extends BuilderState, K extends GovernanceToolId<S>> = K extends keyof NonNullable<
	S['tools']
> &
	string
	? ToolInput<S, K>
	: JsonValue

/**
 * Correlated, transient context for one parsed tool invocation.
 *
 * The harness never serializes `input` or `metadata` into decision events,
 * errors, or audit records.
 */
export type GovernanceContext<
	S extends BuilderState = BuilderState,
	K extends GovernanceToolId<S> = GovernanceToolId<S>,
> =
	K extends GovernanceToolId<S>
		? Readonly<{
				toolId: K
				input: GovernanceToolInput<S, K>
				callId: string
				invocationId: string
				agentId: string
				runId: string
				sessionId: string
				workflowId?: string
				step: number
				metadata: Readonly<Record<string, JsonValue>>
				signal: AbortSignal
				deadline: number
			}>
		: never

/** Strict decision returned by a policy adapter or native rule. */
export type GovernanceDecision = z.infer<typeof import('../decisions/schemas.js').governanceDecisionSchema>

/**
 * Application-owned policy evaluator for an external engine or bespoke policy service.
 *
 * Core does not create a vendor client or define request mapping, credentials,
 * policy distribution, or availability. The optional
 * `@purista/harness-policy-opa` package implements OPA's Data API; Cedar and
 * bespoke engines use focused application-owned implementations. Every adapter
 * maps the parsed {@link GovernanceContext} and returns a validated Harness
 * decision.
 */
export interface GovernancePolicyEvaluator<S extends BuilderState = BuilderState> {
	id: string
	version?: string
	/** Stable, low-cardinality policy engine identifier used only for telemetry. */
	engine?: string
	/** Optional adapter hook for inheriting Harness telemetry and logging. */
	configureHarnessContext?: (context: HarnessAdapterContext) => void
	evaluate(
		ctx: GovernanceContext<S>,
	):
		| GovernanceDecision
		| readonly GovernanceDecision[]
		| undefined
		| Promise<GovernanceDecision | readonly GovernanceDecision[] | undefined>
}

/** Context passed to tool-exposure policy rules before the model sees a step's tool list. */
export interface GovernanceToolExposureContext<
	S extends BuilderState = BuilderState,
	K extends GovernanceToolId<S> = GovernanceToolId<S>,
> extends DecisionExecutionContext {
	/** Canonical tool id whose model exposure is under evaluation. */
	toolId: K
	/** Current agent id. */
	agentId: string
	/** Current run id. */
	runId: string
	/** Current session id. */
	sessionId: string
	/** Current workflow id when the agent is invoked from a workflow. */
	workflowId?: string
	/** Zero-based default-loop model step. */
	step: number
	/** Scalar invocation metadata. */
	metadata: Readonly<Record<string, JsonValue>>
}

/** Native tool-exposure rule scoped to one or more tool ids. */
export interface GovernanceToolExposureRuleForTool<S extends BuilderState, K extends GovernanceToolId<S>> {
	id: string
	description?: string
	effect: GovernanceExposureEffect
	tools?: readonly K[]
	when?: (ctx: GovernanceToolExposureContext<S, K>) => boolean | Promise<boolean>
}

/** Native tool-exposure rule with a full tool-context union. */
export type GovernanceToolExposureRule<S extends BuilderState> = GovernanceToolExposureRuleForTool<
	S,
	GovernanceToolId<S>
>

/** Optional pre-model tool-exposure policy. */
export interface GovernanceToolExposurePolicy<S extends BuilderState = BuilderState> {
	id?: string
	version?: string
	defaultEffect?: GovernanceExposureEffect
	rules?: readonly GovernanceToolExposureRule<S>[]
}

/** Native TypeScript policy rule scoped to one or more tool ids. */
export interface NativePolicyRuleForTool<S extends BuilderState, K extends GovernanceToolId<S>> {
	id: string
	description?: string
	effect: GovernanceEffect
	tools?: readonly K[]
	when?: (ctx: GovernanceContext<S, K>) => boolean | Promise<boolean>
	reasonCode?: GovernanceDecision['reasonCode']
}

/** Native policy rule with a full correlated context union. */
export type NativePolicyRule<S extends BuilderState> = NativePolicyRuleForTool<S, GovernanceToolId<S>>

/** Correlated approval subject without callback-only execution fields. */
export type GovernanceApprovalSubject<
	S extends BuilderState = BuilderState,
	K extends GovernanceToolId<S> = GovernanceToolId<S>,
> = K extends GovernanceToolId<S> ? Omit<GovernanceContext<S, K>, 'metadata' | 'signal' | 'deadline'> : never

/** Native policy definition evaluated by the harness without an external policy engine. */
export interface NativePolicyDefinition<S extends BuilderState = BuilderState> {
	kind: 'native'
	id: string
	version?: string
	description?: string
	rules: readonly NativePolicyRule<S>[]
}

export type GovernancePolicyDefinition<S extends BuilderState = BuilderState> =
	| NativePolicyDefinition<S>
	| GovernancePolicyEvaluator<S>

/** Approval request for exactly one tool occurrence. */
export type GovernanceApprovalRequest<S extends BuilderState = BuilderState> = S extends BuilderState
	? {
			approvalId: string
			subject: GovernanceApprovalSubject<S>
			demands: readonly import('../decisions/types.js').DecisionEvidence[]
		}
	: never

/** Strict result from an immediate approval provider. */
export type GovernanceApprovalResult = z.infer<typeof import('../decisions/schemas.js').governanceApprovalResultSchema>

/** Optional approval adapter used only by policies that return `require_approval`. */
export type GovernanceApprovalProvider<S extends BuilderState = BuilderState> = S extends BuilderState
	? {
			request: (
				request: GovernanceApprovalRequest<S>,
				execution: DecisionExecutionContext,
			) => Promise<GovernanceApprovalResult>
		}
	: never

/** Content-free audit record emitted after governance validation. */
export interface GovernanceAuditRecord {
	evidence: import('../decisions/types.js').DecisionEvidence
	toolId: string
	callId: string
	invocationId: string
	agentId: string
	runId: string
	sessionId: string
	workflowId?: string
	step: number
	effect: GovernanceEffect
	enforced: boolean
}

/** Optional audit sink for policy decisions. */
export interface GovernanceAuditSink {
	record(
		record: GovernanceAuditRecord,
		execution: import('../decisions/types.js').DecisionExecutionContext,
	): Promise<void>
}

/** Optional policy-driven governance layer. Omitted config leaves the harness behavior unchanged. */
export interface GovernanceConfig<S extends BuilderState = BuilderState> {
	enabled?: boolean
	mode?: GovernanceMode
	defaultEffect?: 'allow' | 'deny'
	policies?: readonly GovernancePolicyDefinition<S>[]
	exposure?: GovernanceToolExposurePolicy<S>
	approval?: GovernanceApprovalProvider<S>
	audit?: GovernanceAuditSink
}

export interface GovernanceDefinitionHelpers<S extends BuilderState> {
	rule<const K extends readonly GovernanceToolId<S>[]>(
		definition: NativePolicyRuleForTool<S, NoInfer<K[number]>> & { tools: K },
	): NativePolicyRule<S>
	rule(definition: NativePolicyRuleForTool<S, GovernanceToolId<S>> & { tools?: undefined }): NativePolicyRule<S>
	exposureRule<const K extends readonly GovernanceToolId<S>[]>(
		definition: GovernanceToolExposureRuleForTool<S, NoInfer<K[number]>> & { tools: K },
	): GovernanceToolExposureRule<S>
	exposureRule(
		definition: GovernanceToolExposureRuleForTool<S, GovernanceToolId<S>> & { tools?: undefined },
	): GovernanceToolExposureRule<S>
	native<const P extends Omit<NativePolicyDefinition<S>, 'kind'>>(definition: P): P & { kind: 'native' }
	/**
	 * Preserves builder-derived tool and input types for an application-owned
	 * {@link GovernancePolicyEvaluator}.
	 *
	 * This registration helper performs no I/O and does not create a vendor
	 * client, connect to a policy engine, load policy bundles, or map vendor
	 * decisions.
	 */
	adapter<const P extends GovernancePolicyEvaluator<S>>(definition: P): P
}

/** Full context passed to workflow handlers. */
export interface WorkflowContext<S extends BuilderState, I, O> {
	input: I
	agents: {
		[K in keyof NonNullable<S['agents']>]: (
			input: AgentInput<S, K>,
			opts?: WorkflowAgentInvokeOptions<S, K>,
		) => Promise<AgentOutput<S, K>>
	}
	models: ModelHandles<S>
	/** Harness logger scoped for workflow handler code. */
	logger: Logger
	/** Harness telemetry bridge for framework-level traces and diagnostics. */
	telemetry: TelemetryShim
	signal: AbortSignal
	runId: string
	sessionId: string
	metadata: Readonly<Record<string, JsonValue>>
	memory: MemoryFacade
	/**
	 * Persists an application-owned external decision checkpoint and suspends a
	 * durable workflow until a terminal signal is delivered. It never stores
	 * review content or authenticates a reviewer; those remain application code.
	 */
	externalWait: {
		wait(request: ExternalWaitRequest): Promise<ExternalWaitResolved>
	}
	metrics: Metrics
	/**
	 * Runs `fn` as a durable step. Under a durable invocation the output is
	 * checkpointed and replayed on resume without re-running `fn`; otherwise it is
	 * a transparent pass-through. See spec 10 "Durable steps".
	 */
	step<T extends JsonValue>(stepId: string, fn: () => Promise<T>, options?: DurableStepOptions): Promise<T>
	/**
	 * Runs independent workflow work with bounded, cancellation-aware
	 * concurrency. Results retain input order. The effective concurrency never
	 * exceeds this workflow's child-agent delegation budget.
	 */
	fanOut<T, R>(
		items: readonly T[],
		worker: (item: T, index: number) => Promise<R>,
		options?: WorkflowFanOutOptions,
	): Promise<R[]>
	/** Starts an isolated, workflow-owned child-agent task. */
	childTasks: WorkflowChildTasks<S>
	output?: O
}

/** Configuration for one typed workflow fan-out batch. */
export interface WorkflowFanOutOptions {
	/** Maximum concurrently executing workers. Defaults to the workflow child-agent budget. */
	concurrency?: number
}

/** Content policy for workflow-owned child tasks. Only isolated execution ships in core. */
export type ChildTaskContextPolicy = 'isolated'

/** Lifecycle shape for a workflow-owned child task. */
export type ChildTaskMode = 'one_shot' | 'continuable'

/** Immutable, non-content task descriptor persisted with the task run. */
export interface ChildTaskDescriptor {
	readonly id: string
	readonly parentRunId: string
	readonly sessionId: string
	readonly workflowId: string
	readonly agentId: string
	readonly modelAlias?: string
	readonly contextPolicy: ChildTaskContextPolicy
	readonly mode: ChildTaskMode
	readonly createdAt: string
}

/** Snapshot available to a task handle and session owner. */
export interface ChildTaskStatus {
	readonly descriptor: ChildTaskDescriptor
	readonly status: 'running' | 'succeeded' | 'failed' | 'cancelled'
	readonly finishedAt?: string
	readonly error?: SerializedError
}

/** Opaque workflow-owned handle for a single child-agent task. */
export interface ChildTaskHandle<O> {
	readonly id: string
	/** Resolves with the child output or rejects with its original failure. */
	result(): Promise<O>
	/** Returns a content-free lifecycle snapshot. */
	status(): Promise<ChildTaskStatus>
	/** Idempotently requests cancellation and waits for terminal settlement. */
	cancel(reason?: string): Promise<void>
}

/**
 * A task whose isolated conversation and sandbox remain live between explicit
 * turns. Continuable tasks are in-process handles: they intentionally do not
 * claim cross-process recovery until a durable task-worker adapter exists.
 */
export interface ContinuableChildTaskHandle<I, O> extends ChildTaskHandle<O> {
	/** Queues one isolated follow-up turn after any active turn settles. */
	send(input: I): Promise<O>
	/** Ends the task successfully after its final queued turn has settled. */
	close(): Promise<O | undefined>
}

/** Start options for a workflow-owned child task. */
export type ChildTaskStartOptions<S extends BuilderState, K extends keyof NonNullable<S['agents']>> = {
	/** A stable caller-chosen idempotency key for a durable workflow step. */
	idempotencyKey?: string
	/** Per-task timeout. Defaults to the workflow run timeout policy. */
	timeoutMs?: number
	/** A configured, policy-allowed model alias override. */
	model?: keyof NonNullable<S['models']> & string
	/** Only isolated history is supported; raw parent-history inheritance is intentionally absent. */
	context?: ChildTaskContextPolicy
	/** Filesystem partition policy for this child invocation only. */
	sandbox?: SandboxPolicy<ConfiguredSandboxGroups<S>>
	/** Runs exactly one agent turn and then settles the task. */
	mode?: 'one_shot'
}

/** Start options for an in-process continuable child task. */
export type ContinuableChildTaskStartOptions<S extends BuilderState, K extends keyof NonNullable<S['agents']>> = Omit<
	ChildTaskStartOptions<S, K>,
	'mode'
> & {
	/** Keeps an isolated task-owned conversation and sandbox open for `send(...)` turns. */
	mode: 'continuable'
}

/** Typed child-task API available only to a running workflow handler. */
export interface WorkflowChildTasks<S extends BuilderState> {
	start<K extends keyof NonNullable<S['agents']>>(
		agentId: K,
		input: AgentInput<S, K>,
		options: ContinuableChildTaskStartOptions<S, K>,
	): Promise<ContinuableChildTaskHandle<AgentInput<S, K>, AgentOutput<S, K>>>
	start<K extends keyof NonNullable<S['agents']>>(
		agentId: K,
		input: AgentInput<S, K>,
		options?: ChildTaskStartOptions<S, K>,
	): Promise<ChildTaskHandle<AgentOutput<S, K>>>
}

/** Invoke options accepted by workflow-local child-agent calls. */
export type WorkflowAgentInvokeOptions<
	S extends BuilderState,
	K extends keyof NonNullable<S['agents']>,
> = InvokeOptions & {
	/**
	 * Optional model alias override for this child-agent call.
	 * The alias must exist on the harness model registry and be allowed by the
	 * workflow delegation policy.
	 */
	model?: keyof NonNullable<S['models']> & string
}

/** Full context passed to custom agent handlers. */
export interface AgentContext<S extends BuilderState, I, O> extends AgentContextMinimal<S, I> {
	/**
	 * Model handles scoped to the active harness run.
	 *
	 * Calls retain the harness trace/session/run attribution. Pass
	 * `{ emitRunEvents: true }` as the final invocation argument when the
	 * corresponding model completion or stream chunks should be exposed through
	 * `session.agents.<id>.stream(...)`. The harness owns event identity and
	 * persistence; custom handlers cannot forge arbitrary run events.
	 *
	 * @example
	 * ```ts
	 * const response = await ctx.models.primary.object(
	 *   { messages: [{ role: 'user', content: ctx.input }], schema },
	 *   ctx.signal,
	 *   { emitRunEvents: true }
	 * )
	 * ```
	 */
	models: ModelHandles<S>
	/** Harness logger scoped for custom agent handler code. */
	logger: Logger
	/** Harness telemetry bridge for framework-level traces and diagnostics. */
	telemetry: TelemetryShim
	signal: AbortSignal
	output?: O
}

/**
 * Properties shared by default-loop and custom-handler agent declarations.
 *
 * Most applications should use {@link AgentDefinition}. This named public
 * shape keeps inferred builder return types portable when an application emits
 * TypeScript declarations.
 */
export interface AgentDefinitionCommon<
	S extends BuilderState,
	I extends AnySchema = AnySchema,
	O extends AnySchema = AnySchema,
> {
	input?: I & JsonOutputSchema<I>
	output?: O & JsonOutputSchema<O>
	/** Portable output updates available to streaming consumers. Default: `none`. */
	updates?: OutputUpdateMode
	tools?: readonly (keyof NonNullable<S['tools']> & string)[]
	/**
	 * Built-in filesystem or process tools explicitly exposed to this agent.
	 * Default: none. A default-loop agent with `skills` must include `read` so
	 * it can load the mounted `SKILL.md` instructions.
	 */
	builtinTools?: readonly BuiltinToolName[] | false
	skills?: readonly (keyof NonNullable<S['skills']> & string)[]
	permissions?: AgentPermissions
	/** Filesystem partition policy for this agent. Omit to inherit its caller. */
	sandbox?: SandboxPolicy<ConfiguredSandboxGroups<S>>
}

type DefaultLoopAgentDefinition<
	S extends BuilderState,
	I extends AnySchema,
	O extends AnyModelSchema,
> = AgentDefinitionCommon<S, I, O> & {
	handler?: never
	model: keyof NonNullable<S['models']> & string
	instructions: string | ((ctx: AgentContextMinimal<S, Infer<I>>) => string)
	/**
	 * Maximum model iterations for this default-loop agent. Falls back to
	 * `defaults.agentMaxIterations`. Must be a positive integer; explicit values
	 * are not otherwise capped.
	 */
	maxSteps?: number
	/**
	 * Optional hook for per-round loop control in the default agent loop.
	 *
	 * @example
	 * ```ts
	 * prepareStep: ({ step }) => step === 0 ? { activeTools: ['lookup'] } : {}
	 * ```
	 */
	prepareStep?: AgentPrepareStep<S, Infer<I>>
	/**
	 * Optional hook that can stop the default loop after a model call.
	 *
	 * @example
	 * ```ts
	 * stopWhen: ({ step }) => step >= 2
	 * ```
	 */
	stopWhen?: AgentStopWhen<S, Infer<I>>
	/** Ordered, fail-closed interception hooks for the built-in agent loop. */
	interceptors?: readonly AgentExecutionInterceptor<S, Infer<I>>[]
	/**
	 * Optional content Guardrails for this built-in agent loop.
	 *
	 * The optional Guardrails package implements the provider-neutral binding;
	 * Harness appends it after explicit {@link interceptors} and validates its
	 * tool/model requirements during `.build()`.
	 *
	 * @example
	 * ```ts
	 * .agent('answer', {
	 *   model: 'support',
	 *   input,
	 *   output,
	 *   instructions: 'Answer the support question concisely.',
	 *   guardrails: supportRails,
	 * })
	 * ```
	 */
	guardrails?: AgentGuardrailsBinding
}

type CustomHandlerAgentDefinition<
	S extends BuilderState,
	I extends AnySchema,
	O extends AnySchema,
> = AgentDefinitionCommon<S, I, O> & {
	handler: (ctx: AgentContext<S, Infer<I>, InferIn<O>>) => Promise<InferIn<O>>
	model?: never
	instructions?: never
	maxSteps?: never
	prepareStep?: never
	stopWhen?: never
	interceptors?: never
	guardrails?: never
}

/**
 * Agent declaration whose output contract depends on its execution mode.
 *
 * A default-loop agent needs a {@link ModelSchema} output so the Harness can
 * project it to JSON Schema. A custom handler validates its own result and
 * therefore accepts any {@link Schema} output.
 */
export type AgentDefinition<
	S extends BuilderState,
	I extends AnySchema = AnySchema,
	O extends AnySchema | undefined = undefined,
> = JsonSchemaConstraint<I> &
	(O extends undefined
		? DefaultLoopAgentDefinition<S, I, AnyModelSchema> | CustomHandlerAgentDefinition<S, I, AnySchema>
		: JsonSchemaConstraint<Extract<O, AnySchema>> &
				(
					| CustomHandlerAgentDefinition<S, I, Extract<O, AnySchema>>
					| (O extends AnyModelSchema ? DefaultLoopAgentDefinition<S, I, O> : never)
				))

type AnyAgentDefinition =
	| DefaultLoopAgentDefinition<any, AnySchema, AnyModelSchema>
	| CustomHandlerAgentDefinition<any, AnySchema, AnySchema>

/** Workflow definition registered through `.workflow(...)` or `.workflows(...)`. */
export interface WorkflowDefinition<
	S extends BuilderState,
	I extends AnySchema = AnySchema,
	O extends AnySchema = AnySchema,
> {
	input?: I & JsonOutputSchema<I>
	output?: O & JsonOutputSchema<O>
	/** Portable output updates available to streaming consumers. Default: `none`. */
	updates?: OutputUpdateMode
	delegation?: WorkflowDelegationPolicy<S>
	/** Filesystem partition policy for this workflow. Omit to inherit its caller. */
	sandbox?: SandboxPolicy<ConfiguredSandboxGroups<S>>
	handler: (ctx: WorkflowContext<S, Infer<I>, InferIn<O>>) => Promise<InferIn<O>>
}

/** Public update shape a definition may emit while its final output is pending. */
export type OutputUpdateMode = 'none' | 'text-delta' | 'object-snapshot'

type AgentSchemaFields = {
	input?: AnySchema
	output?: AnySchema
}

type AgentDefinitionResolved<S extends BuilderState, I extends AnySchema, O extends AnySchema> = AgentDefinition<
	S,
	I,
	O
>

type AgentDefinitionFor<S extends BuilderState, D> = D extends {
	input: infer I extends AnySchema
	output: infer O extends AnySchema
}
	? AgentDefinitionResolved<S, I, O>
	: D extends { input: infer I extends AnySchema }
		? AgentDefinitionResolved<S, I, DefaultModelSchema>
		: D extends { output: infer O extends AnySchema }
			? AgentDefinitionResolved<S, DefaultSchema, O>
			: AgentDefinitionResolved<S, DefaultSchema, DefaultModelSchema>

type AgentsConfigFromSchemaMaps<
	S extends BuilderState,
	A extends { [K in keyof A]: { input: AnySchema; output: AnySchema } },
> = {
	[K in keyof A]: A[K] & AgentDefinitionResolved<S, A[K]['input'], A[K]['output']>
}

type WorkflowSchemaFields = {
	input?: AnySchema
	output?: AnySchema
}

type WorkflowDefinitionResolved<S extends BuilderState, I extends AnySchema, O extends AnySchema> = WorkflowDefinition<
	S,
	I,
	O
>

/** Policy for workflow-local child-agent delegation through `ctx.agents`. */
export interface WorkflowDelegationPolicy<S extends BuilderState = BuilderState> {
	/** Enable or disable child-agent calls for this workflow. A policy object without this field enables delegation. */
	enabled?: boolean
	/** Child agent ids this workflow may call. Omit to allow all registered agents. */
	agents?: readonly (keyof NonNullable<S['agents']> & string)[]
	/** Per-run child-agent call limit. Overrides `defaults.delegation.maxChildAgentCalls`. */
	maxChildAgentCalls?: number
	/** Per-run active child-agent call limit. Overrides `defaults.delegation.maxParallelChildAgentCalls`. */
	maxParallelChildAgentCalls?: number
	/** Maximum local delegation depth. Overrides `defaults.delegation.maxDepth`. */
	maxDepth?: number
	/** Model aliases allowed for every child-agent call in this workflow, including calls running on the agent's default `model`. */
	modelAliases?: readonly (keyof NonNullable<S['models']> & string)[]
	/** Per-child-agent model alias allowlists. These replace `modelAliases` for the named agent. */
	agentModelAliases?: Partial<
		Record<keyof NonNullable<S['agents']> & string, readonly (keyof NonNullable<S['models']> & string)[]>
	>
}

type WorkflowDefinitionFor<S extends BuilderState, D> = D extends {
	input: infer I extends AnySchema
	output: infer O extends AnySchema
}
	? WorkflowDefinitionResolved<S, I, O>
	: D extends { input: infer I extends AnySchema }
		? WorkflowDefinitionResolved<S, I, DefaultSchema>
		: D extends { output: infer O extends AnySchema }
			? WorkflowDefinitionResolved<S, DefaultSchema, O>
			: WorkflowDefinitionResolved<S, DefaultSchema, DefaultSchema>

type WorkflowsConfigFromSchemaMaps<
	S extends BuilderState,
	W extends { [K in keyof W]: { input: AnySchema; output: AnySchema } },
> = {
	[K in keyof W]: W[K] & WorkflowDefinitionResolved<S, W[K]['input'], W[K]['output']>
}

/** Agent registry shape constrained by the previously declared models/tools/skills. */
export type AgentsConfig<
	S extends BuilderState,
	A extends { [K in keyof A]: AgentSchemaFields } = Record<string, AgentSchemaFields>,
> = {
	[K in keyof A]: A[K] & AgentDefinitionFor<S, A[K]>
}

/** Workflow registry shape constrained by the previously declared agents. */
export type WorkflowsConfig<
	S extends BuilderState,
	W extends { [K in keyof W]: WorkflowSchemaFields } = Record<string, WorkflowSchemaFields>,
> = {
	[K in keyof W]: W[K] & WorkflowDefinitionFor<S, W[K]>
}

/** Durable, authenticated pause that can be resumed without treating it as a failure. */
export type HarnessInterrupt = {
	readonly type: 'external-wait'
	readonly id: string
	readonly revision: string
	readonly kind: string
	readonly schemaVersion: string
	readonly definitionVersion: string
	readonly deadline: string
}

/** Public result shared by aggregate and streaming execution. */
export type RunOutcome<Output, Interrupt = HarnessInterrupt> =
	| { readonly status: 'completed'; readonly runId: string; readonly output: Output }
	| { readonly status: 'interrupted'; readonly runId: string; readonly interrupt: Interrupt }

/**
 * Provider-neutral execution events safe to carry across a service or browser
 * boundary. Operational diagnostics are available separately through
 * {@link AgentInvoker.observe} and {@link WorkflowInvoker.observe}.
 */
export type ExecutionEvent<Output = JsonValue, Interrupt = HarnessInterrupt> =
	| { readonly type: 'run.started'; readonly runId: string; readonly at: string }
	| { readonly type: 'output.text.delta'; readonly runId: string; readonly id: string; readonly delta: string }
	| {
			readonly type: 'output.object.snapshot'
			readonly runId: string
			readonly id: string
			readonly value: JsonValue
	  }
	| {
			readonly type: 'tool.started'
			readonly runId: string
			readonly agentId: string
			readonly toolId: string
			readonly callId: string
			readonly input: JsonValue
	  }
	| {
			readonly type: 'tool.finished'
			readonly runId: string
			readonly agentId: string
			readonly toolId: string
			readonly callId: string
			readonly output?: JsonValue
			readonly error?: SerializedError
	  }
	| {
			readonly type: 'approval.requested'
			readonly runId: string
			readonly agentId: string
			readonly toolId: string
			readonly callId: string
			readonly approvalId: string
	  }
	| { readonly type: 'run.finished'; readonly runId: string; readonly at: string; readonly outcome: RunOutcome<Output, Interrupt> }

/** Typed workflow invoker available under `session.workflows.<id>`. */
export interface WorkflowInvoker<S extends BuilderState, K extends keyof NonNullable<S['workflows']>> {
	/** Runs until completion or a durable, resumable interrupt. */
	run(input: WorkflowInput<S, K>, opts?: InvokeOptions): Promise<RunOutcome<WorkflowOutput<S, K>>>
	/** Streams the portable execution contract, including one terminal outcome. */
	stream(input: WorkflowInput<S, K>, opts?: InvokeOptions): AsyncIterable<ExecutionEvent<WorkflowOutput<S, K>>>
	/** Streams Harness diagnostics for operators and local debugging. */
	observe(input: WorkflowInput<S, K>, opts?: InvokeOptions): AsyncIterable<RunEvent>
}

/** Typed agent invoker available under `session.agents.<id>`. */
export interface AgentInvoker<S extends BuilderState, K extends keyof NonNullable<S['agents']>> {
	/** Runs until completion or a durable, resumable interrupt. */
	run(input: AgentInput<S, K>, opts?: InvokeOptions): Promise<RunOutcome<AgentOutput<S, K>>>
	/** Streams the portable execution contract, including one terminal outcome. */
	stream(input: AgentInput<S, K>, opts?: InvokeOptions): AsyncIterable<ExecutionEvent<AgentOutput<S, K>>>
	/** Streams Harness diagnostics for operators and local debugging. */
	observe(input: AgentInput<S, K>, opts?: InvokeOptions): AsyncIterable<RunEvent>
}

/** Compile-time-only namespace exposed as `harness.$infer`. */
export type InferTypes<S extends BuilderState> = {
	models: keyof NonNullable<S['models']>
	tools: keyof NonNullable<S['tools']>
	skills: keyof NonNullable<S['skills']>
	agents: { [K in keyof NonNullable<S['agents']>]: { input: AgentInput<S, K>; output: AgentOutput<S, K> } }
	workflows: { [K in keyof NonNullable<S['workflows']>]: { input: WorkflowInput<S, K>; output: WorkflowOutput<S, K> } }
}

type DefinitionInputSchema<D> = D extends { input: infer I extends AnySchema } ? I : DefaultSchema
type DefinitionOutputSchema<D> = D extends { output: infer O extends AnySchema } ? O : DefaultSchema

/** Schema-bearing contract exposed for one portable agent or workflow. */
export type HarnessEntryContract<D> = Readonly<{
	input: DefinitionInputSchema<D>
	output: DefinitionOutputSchema<D>
	updates: OutputUpdateMode
}>

/** Immutable, provider-free contribution catalog used by runtime adapters. */
export interface HarnessContributionCatalog<S extends BuilderState> {
	readonly name: string
	readonly models: Readonly<{
		[K in keyof NonNullable<S['models']>]: ModelRequirement
	}>
	readonly hostTools: Readonly<{
		[K in keyof NonNullable<S['tools']> as NonNullable<S['tools']>[K] extends HostToolDefinition
			? K
			: never]: NonNullable<S['tools']>[K] extends HostToolDefinition<infer I, infer O>
			? Readonly<{ input: I; output: O; description: string }>
			: never
	}>
	readonly agents: Readonly<{
		[K in keyof NonNullable<S['agents']>]: HarnessEntryContract<NonNullable<S['agents']>[K]>
	}>
	readonly workflows: Readonly<{
		[K in keyof NonNullable<S['workflows']>]: HarnessEntryContract<NonNullable<S['workflows']>[K]>
	}>
}

/** Concrete model binding supplied when a portable definition is instantiated. */
export type ModelRuntimeBinding = Omit<ModelAlias, 'capabilities'>

/** Runtime model bindings inferred from a portable Harness definition. */
export type HarnessRuntimeModels<S extends BuilderState> = {
	readonly [K in keyof NonNullable<S['models']>]: ModelRuntimeBinding
}

/** Host-tool implementations required by a portable definition. */
export type HarnessHostToolBindings<S extends BuilderState, Host = unknown> = {
	readonly [K in keyof NonNullable<S['tools']> as NonNullable<S['tools']>[K] extends HostToolDefinition
		? K
		: never]: NonNullable<S['tools']>[K] extends HostToolDefinition<infer I, infer O>
		? HostToolBinding<I, O, Host>
		: never
}

/** Infrastructure supplied to a portable Harness definition at startup. */
export type HarnessInstanceConfig<S extends BuilderState, Host = unknown> = {
	readonly models: HarnessRuntimeModels<S>
	readonly logger?: Logger
	readonly telemetry?: TelemetryOptions
	readonly storage?: HarnessStorage
	readonly sandbox?: Sandbox
	readonly sandboxBinding?: SandboxBindingOptions<string>
	readonly memory?:
		| MemoryEngine
		| MemoryConfiguration<readonly import('../ports/memory.js').MemoryCapability[], NonNullable<S['models']>>
		| ((
				models: MemoryModelReferences<NonNullable<S['models']>>,
			) => MemoryConfiguration<readonly import('../ports/memory.js').MemoryCapability[], NonNullable<S['models']>>)
	readonly workspace?: DurableWorkspace
} & (keyof HarnessHostToolBindings<S, Host> extends never
	? { readonly hostTools?: never }
	: { readonly hostTools: HarnessHostToolBindings<S, Host> })

/**
 * Portable Harness definition.
 *
 * It contains schemas and requirements but no provider credentials or live
 * infrastructure. The same value can run standalone or be mounted by a host
 * framework such as PURISTA.
 */
export interface HarnessDefinition<S extends BuilderState> {
	readonly name: string
	readonly catalog: HarnessContributionCatalog<S>
	getInstance<Host = unknown>(config: HarnessInstanceConfig<S, Host>): Promise<Harness<S>>
	/** Phantom inference handle. The runtime value is always the literal `{}`. */
	readonly $infer: InferTypes<S>
}

/** Harness handle returned from `build()`. */
export interface Harness<S extends BuilderState> {
	/**
	 * Opens or creates a session facade bound to `id` and its immutable owner.
	 *
	 * ```ts
	 * const session = await harness.getSession('ticket-123', {
	 *   identity: { tenantId: 'acme' }
	 * })
	 * ```
	 */
	getSession(id: string, options?: SessionOptions): Promise<Session<S>>
	/** Returns a synchronous, data-only snapshot of resolved adapter setup. */
	inspect(): HarnessInspection
	/** Closes harness-owned adapters and returns any shutdown errors. */
	shutdown(): Promise<{ errors: HarnessError[] }>
	/** Phantom inference handle. Harness value is always the literal `{}`. */
	readonly $infer: InferTypes<S>
}

/** Session-scoped operational API. */
export interface Session<S extends BuilderState> {
	readonly id: string
	readonly agents: { readonly [K in keyof NonNullable<S['agents']>]: AgentInvoker<S, K> }
	readonly workflows: { readonly [K in keyof NonNullable<S['workflows']>]: WorkflowInvoker<S, K> }
	/** Session-owner access to child tasks created by this session's workflows. */
	readonly childTasks: SessionChildTasks
	memory: SessionMemory
	history: ConversationHistory
	getRunSummary(runId: string): Promise<RunSummary | undefined>
	clearHistory(): Promise<void>
	replaceHistory(messages: ReadonlyArray<Omit<Message, 'id' | 'timestamp'>>): Promise<void>
	/**
	 * Removes compute owned by this session while retaining its history and run receipts.
	 *
	 * Borrowed owners are only detached, so another authorized session can keep
	 * using the shared owner. A later live invocation of an implicitly owned,
	 * disposed session fails closed instead of allocating an empty replacement.
	 */
	disposeSandbox(): Promise<void>
	/**
	 * Releases live, session-scoped resources without deleting persisted state.
	 *
	 * This closes the active sandbox and sandbox-bound MCP runners, cancels any
	 * resident child tasks, and evicts the in-memory session facade. HarnessStorage-
	 * backed session metadata, conversation history, and run records remain
	 * available when a later `harness.getSession(...)` call reopens the same
	 * id. It is safe to call repeatedly once no run is active.
	 */
	release(): Promise<void>
	/**
	 * Destructively destroys the session and removes its persisted session data.
	 * Use {@link release} when only live sandbox/MCP resources should be freed.
	 */
	destroy(): Promise<void>
}

/** Content-safe task lookup surface owned by a session, not by a workflow. */
export interface SessionChildTasks {
	/** Retrieves a task owned by this session, including a terminal persisted task after restart. */
	get(id: string): Promise<ChildTaskHandle<JsonValue> | undefined>
	/** Lists content-free task lifecycle snapshots for this session. */
	list(opts?: { limit?: number; before?: string }): Promise<readonly ChildTaskStatus[]>
}

/** Structured run-event error payload. */
export interface SerializedError {
	code: string
	category: string
	retriable: boolean
	message: string
	meta?: Record<string, unknown>
}

export interface RunSummary {
	runId: string
	sessionId: string
	status: RunStatus
	startedAt: string
	finishedAt?: string
	tokenTotals: TokenUsage
	modelCalls: number
	toolCalls: number
	agentCalls: number
	error?: SerializedError
}

/**
 * Harness streaming events emitted from `session.workflows.<id>.stream(...)`.
 *
 * `text(...)` and `object(...)` model calls return final results and do not
 * expose partial output. Consumed model streams are private by default.
 * `model.delta`, `model.object.partial`, and streamed `model.object` are
 * emitted only when that `textStream(...)` or `objectStream(...)` call passes
 * `{ emitRunEvents: true }`.
 */
export type RunEvent =
	| { type: 'run.started'; runId: string; at: string }
	| { type: 'run.finished'; runId: string; at: string; output?: JsonValue; error?: SerializedError }
	| {
			type: 'external_wait.requested'
			runId: string
			at: string
			waitId: string
			kind: string
			schemaVersion: string
			definitionVersion: string
			deadline: string
	  }
	| { type: 'external_wait.waiting'; runId: string; at: string; waitId: string; kind: string; deadline: string }
	| {
			type: 'external_wait.resolved'
			runId: string
			at: string
			waitId: string
			kind: string
			outcome: ExternalWaitOutcome
			deadline: string
	  }
	| { type: 'fanout.started'; runId: string; batchId: string; at: string; count: number; concurrency: number }
	| {
			type: 'fanout.finished'
			runId: string
			batchId: string
			at: string
			count: number
			status: 'succeeded' | 'failed' | 'cancelled'
	  }
	| {
			type: 'child_task.started'
			runId: string
			taskId: string
			at: string
			parentRunId: string
			workflowId: string
			agentId: string
			modelAlias?: string
			contextPolicy: ChildTaskContextPolicy
			mode: ChildTaskMode
	  }
	| {
			type: 'child_task.settled'
			runId: string
			taskId: string
			at: string
			parentRunId: string
			workflowId: string
			agentId: string
			status: 'succeeded' | 'failed' | 'cancelled'
			error?: SerializedError
	  }
	| {
			type: 'agent.started'
			runId: string
			agentId: string
			at: string
			workflowId?: string
			parentAgentId?: string
			delegationCallId?: string
			delegationDepth?: number
			modelAlias?: string
	  }
	| {
			type: 'agent.finished'
			runId: string
			agentId: string
			at: string
			workflowId?: string
			parentAgentId?: string
			delegationCallId?: string
			delegationDepth?: number
			modelAlias?: string
			output?: JsonValue
			error?: SerializedError
	  }
	| {
			type: 'model.delta'
			runId: string
			streamId: string
			agentId?: string
			workflowId?: string
			modelAlias?: string
			delta: string
	  }
	| {
			type: 'policy.evaluated'
			runId: string
			agentId: string
			invocationId: string
			toolId: string
			callId: string
			step: number
			evidence: import('../decisions/types.js').DecisionEvidence
			effect: GovernanceEffect
			enforced: boolean
	  }
	| {
			type: 'policy.exposure'
			runId: string
			agentId: string
			invocationId: string
			toolId: string
			step: number
			evidence: import('../decisions/types.js').DecisionEvidence
			effect: GovernanceExposureEffect
			enforced: boolean
	  }
	| {
			type: 'approval.requested'
			runId: string
			agentId: string
			invocationId: string
			toolId: string
			callId: string
			step: number
			approvalId: string
			demands: readonly import('../decisions/types.js').DecisionEvidence[]
	  }
	| {
			type: 'approval.finished'
			runId: string
			agentId: string
			invocationId: string
			toolId: string
			callId: string
			step: number
			approvalId: string
			outcome: 'approved' | 'rejected' | 'cancelled' | 'timed_out' | 'failed'
			reasonCode?: string
			errorCode?: string
	  }
	| { type: 'tool.started'; runId: string; agentId: string; toolId: string; callId: string; input: JsonValue }
	| {
			type: 'tool.finished'
			runId: string
			agentId: string
			toolId: string
			callId: string
			output?: JsonValue
			error?: SerializedError
	  }
	| { type: 'model.message'; runId: string; agentId: string; message: Message }
	| {
			type: 'model.object.partial'
			runId: string
			streamId: string
			agentId?: string
			workflowId?: string
			modelAlias?: string
			partial: JsonValue
	  }
	| {
			type: 'model.completed'
			runId: string
			agentId?: string
			workflowId?: string
			modelAlias: string
			streamId?: string
			operation: 'text' | 'object' | 'textStream' | 'objectStream'
			usage?: TokenUsage
			finishReason?: import('../ports/model-provider.js').FinishReason
	  }
	| {
			type: 'model.object'
			runId: string
			agentId?: string
			workflowId?: string
			modelAlias?: string
			streamId?: string
			object: JsonValue
	  }
	| {
			type: 'model.embedding.completed'
			runId: string
			agentId?: string
			count: number
			dimensions?: number
			usage?: TokenUsage
	  }
	| {
			type: 'model.rerank.completed'
			runId: string
			agentId?: string
			count: number
			topN?: number
			usage?: TokenUsage
	  }
	| { type: 'stream.overflow'; runId: string; at: string; dropped: number }

/** Fluent builder contract for composing a harness. */
export interface HarnessBuilder<S extends BuilderState = {}> {
	/** Applies a local, static harness module to this builder. */
	use<Required extends BuilderState, Result extends BuilderState, Id extends string>(
		module: S extends Required ? HarnessModule<Required, Result, Id> : never,
	): HarnessBuilder<S & Result>
	telemetry(opts: TelemetryOptions): HarnessBuilder<S>
	logger(logger: Logger): HarnessBuilder<S>
	storage(storage: HarnessStorage): HarnessBuilder<S>
	/** Register the sandbox before tools to infer their supported file, exec, and spawn operations. */
	sandbox(): HarnessBuilder<S & { sandboxCapabilities: readonly AdapterCapability[] }>
	/** Auto-detect a sandbox while applying the service-owned sharing and owner-authorization policy. */
	sandbox<const G extends string>(
		sandbox: undefined,
		options: SandboxBindingOptions<G>,
	): HarnessBuilder<S & { sandboxCapabilities: readonly AdapterCapability[]; sandboxGroups: readonly G[] }>
	sandbox<const A extends Sandbox>(
		sandbox: A,
	): HarnessBuilder<S & { sandboxCapabilities: NonNullable<A['capabilities']> }>
	sandbox<const A extends Sandbox, const G extends string>(
		sandbox: A,
		options: SandboxBindingOptions<G>,
	): HarnessBuilder<S & { sandboxCapabilities: NonNullable<A['capabilities']>; sandboxGroups: readonly G[] }>
	memory<const C extends readonly import('../ports/memory.js').MemoryCapability[]>(
		engine: MemoryEngine<C>,
	): HarnessBuilder<S>
	memory<const C extends readonly import('../ports/memory.js').MemoryCapability[]>(
		configuration: MemoryConfiguration<C, NonNullable<S['models']>>,
	): HarnessBuilder<S>
	memory<const C extends readonly import('../ports/memory.js').MemoryCapability[]>(
		configuration: (
			model: MemoryModelReferences<NonNullable<S['models']>>,
		) => MemoryConfiguration<C, NonNullable<S['models']>>,
	): HarnessBuilder<S>
	workspace(workspace: DurableWorkspace): HarnessBuilder<S>
	requires(capabilities: readonly AdapterCapability[]): HarnessBuilder<S>
	defaults(defaults: HarnessDefaults): HarnessBuilder<S>
	/** Declares one provider-neutral model requirement for a portable definition. */
	requireModel<const Id extends string, const R extends ModelRequirement>(
		id: Id,
		requirement: R,
	): HarnessBuilder<S & { models: Record<Id, R & ModelAlias> }>
	/** Declares provider-neutral model requirements for a portable definition. */
	requireModels<const R extends ModelTypesConfig>(requirements: R): HarnessBuilder<S & { models: RequiredModelTypes<R> }>
	/** Registers one model alias and preserves its literal id for later agents. */
	model<const Id extends string, const D extends ModelAlias>(
		id: Id,
		definition: D,
	): HarnessBuilder<S & { models: Record<Id, D> }>
	/** Registers a reusable model-alias record. Repeated calls accumulate. */
	models<const M extends ModelsConfig>(models: M): HarnessBuilder<S & { models: M }>
	/**
	 * Registers one native tool with schema-derived handler types.
	 * Prefer this method for inline native definitions.
	 */
	tool<const Id extends string, const I extends AnyModelSchema, const O extends AnySchema>(
		id: Id,
		definition: TsToolDefinition<I, O, ToolContextFor<S>>,
	): HarnessBuilder<S & { tools: Record<Id, TsToolDefinition<I, O, ToolContextFor<S>>> }>
	tool<const Id extends string, const D extends McpStdioToolDefinition | McpHttpToolDefinition>(
		id: Id,
		definition: D,
	): HarnessBuilder<S & { tools: Record<Id, D> }>
	/** Declares a provider-neutral tool contract implemented when the Harness is instantiated. */
	hostTool<const Id extends string, const I extends AnyModelSchema, const O extends AnySchema>(
		id: Id,
		definition: HostToolDefinition<I, O>,
	): HarnessBuilder<S & { tools: Record<Id, HostToolDefinition<I, O>> }>
	/**
	 * Registers a cohesive pre-typed native/MCP tool record.
	 * Use {@link tool} for contextual typing of an inline native handler.
	 */
	tools<const T extends Record<string, { input: AnyModelSchema; output: AnySchema }>>(
		tools: T & NativeToolsConfigFromSchemaMaps<ToolContextFor<S>, T>,
	): HarnessBuilder<S & { tools: NativeToolsConfigFromSchemaMaps<ToolContextFor<S>, T> }>
	tools<const T extends Record<string, ToolSchemaFields>>(
		tools: T & ToolsConfigFromSchemaMaps<ToolContextFor<S>, T>,
	): HarnessBuilder<S & { tools: ToolsConfigFromSchemaMaps<ToolContextFor<S>, T> }>
	/** Registers one Agent Skill directory under its validated skill id. */
	skill<const Id extends string, const D extends SkillDefinition>(
		id: Id,
		definition: D,
	): HarnessBuilder<S & { skills: Record<Id, D> }>
	/** Registers a reusable Agent Skill record. Repeated calls accumulate. */
	skills<const K extends SkillsConfig>(skills: K): HarnessBuilder<S & { skills: K }>
	/**
	 * Registers one agent while preserving its literal id and schema types.
	 * Repeat this method or mix it with {@link agents}; duplicate ids fail.
	 *
	 * @param id Stable id exposed as `session.agents[id]` and to later workflows.
	 * @param definition Provider-neutral agent definition. Models, tools, and skills
	 * must already exist in the accumulated builder state.
	 * @returns A new builder whose agent registry includes this definition.
	 */
	agent<
		const Id extends string,
		const I extends AnySchema = DefaultSchema,
		const O extends AnySchema | undefined = undefined,
	>(
		id: Id,
		definition: AgentDefinition<
			S & { models: NonNullable<S['models']>; tools: NonNullable<S['tools']>; skills: NonNullable<S['skills']> },
			I,
			O
		>,
	): HarnessBuilder<
		S & {
			agents: Record<
				Id,
				AgentDefinition<
					S & { models: NonNullable<S['models']>; tools: NonNullable<S['tools']>; skills: NonNullable<S['skills']> },
					I,
					O
				>
			>
		}
	>
	/**
	 * Registers a cohesive record of already typed agent definitions.
	 * This method accumulates with {@link agent}; it never replaces the registry.
	 * Prefer repeated singular calls for inline definitions whose callbacks rely
	 * on schema-derived contextual types.
	 */
	agents<const A extends Record<string, { input: AnySchema; output: AnySchema }>>(
		agents: A &
			AgentsConfigFromSchemaMaps<
				S & { models: NonNullable<S['models']>; tools: NonNullable<S['tools']>; skills: NonNullable<S['skills']> },
				A
			>,
	): HarnessBuilder<
		S & {
			agents: AgentsConfigFromSchemaMaps<
				S & { models: NonNullable<S['models']>; tools: NonNullable<S['tools']>; skills: NonNullable<S['skills']> },
				A
			>
		}
	>
	agents<const A extends Record<string, AgentSchemaFields>>(
		agents: A &
			AgentsConfig<
				S & { models: NonNullable<S['models']>; tools: NonNullable<S['tools']>; skills: NonNullable<S['skills']> },
				A
			>,
	): HarnessBuilder<
		S & {
			agents: AgentsConfig<
				S & { models: NonNullable<S['models']>; tools: NonNullable<S['tools']>; skills: NonNullable<S['skills']> },
				A
			>
		}
	>
	/**
	 * Registers one workflow while preserving its literal id and schema types.
	 * Repeat this method or mix it with {@link workflows}; duplicate ids fail.
	 *
	 * @param id Stable id exposed as `session.workflows[id]`.
	 * @param definition Workflow definition typed from all agents accumulated so far.
	 * @returns A new builder whose workflow registry includes this definition.
	 */
	workflow<
		const Id extends string,
		const I extends AnySchema = DefaultSchema,
		const O extends AnySchema = DefaultSchema,
	>(
		id: Id,
		definition: WorkflowDefinition<S & { agents: NonNullable<S['agents']> }, I, O>,
	): HarnessBuilder<S & { workflows: Record<Id, WorkflowDefinition<S & { agents: NonNullable<S['agents']> }, I, O>> }>
	/**
	 * Registers a cohesive record of already typed workflow definitions.
	 * This method accumulates with {@link workflow}; it never replaces the registry.
	 */
	workflows<const W extends Record<string, { input: AnySchema; output: AnySchema }>>(
		workflows: W & WorkflowsConfigFromSchemaMaps<S & { agents: NonNullable<S['agents']> }, W>,
	): HarnessBuilder<S & { workflows: WorkflowsConfigFromSchemaMaps<S & { agents: NonNullable<S['agents']> }, W> }>
	workflows<const W extends Record<string, WorkflowSchemaFields>>(
		workflows: W & WorkflowsConfig<S & { agents: NonNullable<S['agents']> }, W>,
	): HarnessBuilder<S & { workflows: WorkflowsConfig<S & { agents: NonNullable<S['agents']> }, W> }>
	governance(
		config: GovernanceConfig<S> | ((helpers: GovernanceDefinitionHelpers<S>) => GovernanceConfig<S>),
	): HarnessBuilder<S>
	/** Freezes a provider-neutral definition that can be instantiated standalone or by a host integration. */
	define(): HarnessDefinition<S>
	build(): Harness<S>
}

/** Builder surface exposed to a static harness module. It deliberately has no build or use method. */
export interface HarnessModuleBuilder<S extends BuilderState = {}> {
	model<const Id extends string, const D extends ModelAlias>(
		id: Id,
		definition: D,
	): HarnessModuleBuilder<S & { models: Record<Id, D> }>
	models<const M extends ModelsConfig>(models: M): HarnessModuleBuilder<S & { models: M }>
	tool<const Id extends string, const I extends AnyModelSchema, const O extends AnySchema>(
		id: Id,
		definition: TsToolDefinition<I, O, ToolContextFor<S>>,
	): HarnessModuleBuilder<S & { tools: Record<Id, TsToolDefinition<I, O, ToolContextFor<S>>> }>
	tool<const Id extends string, const D extends McpStdioToolDefinition | McpHttpToolDefinition>(
		id: Id,
		definition: D,
	): HarnessModuleBuilder<S & { tools: Record<Id, D> }>
	hostTool<const Id extends string, const I extends AnyModelSchema, const O extends AnySchema>(
		id: Id,
		definition: HostToolDefinition<I, O>,
	): HarnessModuleBuilder<S & { tools: Record<Id, HostToolDefinition<I, O>> }>
	tools<const T extends Record<string, { input: AnyModelSchema; output: AnySchema }>>(
		tools: T & NativeToolsConfigFromSchemaMaps<ToolContextFor<S>, T>,
	): HarnessModuleBuilder<S & { tools: NativeToolsConfigFromSchemaMaps<ToolContextFor<S>, T> }>
	tools<const T extends Record<string, ToolSchemaFields>>(
		tools: T & ToolsConfigFromSchemaMaps<ToolContextFor<S>, T>,
	): HarnessModuleBuilder<S & { tools: ToolsConfigFromSchemaMaps<ToolContextFor<S>, T> }>
	skill<const Id extends string, const D extends SkillDefinition>(
		id: Id,
		definition: D,
	): HarnessModuleBuilder<S & { skills: Record<Id, D> }>
	skills<const K extends SkillsConfig>(skills: K): HarnessModuleBuilder<S & { skills: K }>
	agent<
		const Id extends string,
		const I extends AnySchema = DefaultSchema,
		const O extends AnySchema | undefined = undefined,
	>(
		id: Id,
		definition: AgentDefinition<
			S & { models: NonNullable<S['models']>; tools: NonNullable<S['tools']>; skills: NonNullable<S['skills']> },
			I,
			O
		>,
	): HarnessModuleBuilder<
		S & {
			agents: Record<
				Id,
				AgentDefinition<
					S & { models: NonNullable<S['models']>; tools: NonNullable<S['tools']>; skills: NonNullable<S['skills']> },
					I,
					O
				>
			>
		}
	>
	agents<const A extends Record<string, { input: AnySchema; output: AnySchema }>>(
		agents: A &
			AgentsConfigFromSchemaMaps<
				S & { models: NonNullable<S['models']>; tools: NonNullable<S['tools']>; skills: NonNullable<S['skills']> },
				A
			>,
	): HarnessModuleBuilder<
		S & {
			agents: AgentsConfigFromSchemaMaps<
				S & { models: NonNullable<S['models']>; tools: NonNullable<S['tools']>; skills: NonNullable<S['skills']> },
				A
			>
		}
	>
	agents<const A extends Record<string, AgentSchemaFields>>(
		agents: A &
			AgentsConfig<
				S & { models: NonNullable<S['models']>; tools: NonNullable<S['tools']>; skills: NonNullable<S['skills']> },
				A
			>,
	): HarnessModuleBuilder<
		S & {
			agents: AgentsConfig<
				S & { models: NonNullable<S['models']>; tools: NonNullable<S['tools']>; skills: NonNullable<S['skills']> },
				A
			>
		}
	>
	workflow<
		const Id extends string,
		const I extends AnySchema = DefaultSchema,
		const O extends AnySchema = DefaultSchema,
	>(
		id: Id,
		definition: WorkflowDefinition<S & { agents: NonNullable<S['agents']> }, I, O>,
	): HarnessModuleBuilder<
		S & { workflows: Record<Id, WorkflowDefinition<S & { agents: NonNullable<S['agents']> }, I, O>> }
	>
	workflows<const W extends Record<string, { input: AnySchema; output: AnySchema }>>(
		workflows: W & WorkflowsConfigFromSchemaMaps<S & { agents: NonNullable<S['agents']> }, W>,
	): HarnessModuleBuilder<S & { workflows: WorkflowsConfigFromSchemaMaps<S & { agents: NonNullable<S['agents']> }, W> }>
	workflows<const W extends Record<string, WorkflowSchemaFields>>(
		workflows: W & WorkflowsConfig<S & { agents: NonNullable<S['agents']> }, W>,
	): HarnessModuleBuilder<S & { workflows: WorkflowsConfig<S & { agents: NonNullable<S['agents']> }, W> }>
}

/** A local static transform that contributes definitions to one harness builder. */
export interface HarnessModule<
	Required extends BuilderState = BuilderState,
	Result extends BuilderState = BuilderState,
	Id extends string = string,
> {
	readonly id: Id
	readonly version?: string
	readonly requires?: readonly AdapterCapability[]
	readonly register: (builder: HarnessModuleBuilder<Required>) => HarnessModuleBuilder<Result>
}

/** Defines a local static harness module. It does not construct or load a harness. */
export function defineHarnessModule<Required extends BuilderState = {}>(): <
	const Id extends string,
	Result extends BuilderState,
>(
	id: Id,
	definition: Omit<HarnessModule<Required, Result, Id>, 'id'>,
) => HarnessModule<Required, Result, Id> {
	return (id, definition) => Object.freeze({ id, ...definition })
}

type BuilderStateInternal = {
	telemetry?: TelemetryOptions
	logger?: Logger
	storage?: HarnessStorage
	sandbox?: Sandbox
	sandboxBinding?: SandboxBindingOptions<string>
	memory?: MemoryEngine | MemoryConfiguration | ((model: MemoryModelReferences<ModelsConfig>) => MemoryConfiguration)
	workspace?: DurableWorkspace
	requiredCapabilities?: readonly AdapterCapability[]
	defaults?: HarnessDefaults
	models?: ModelsConfig
	modelRequirements?: ModelTypesConfig
	tools?: AuthoredToolsConfig<never>
	skills?: SkillsConfig
	agents?: Record<string, AnyAgentDefinition>
	workflows?: Record<string, WorkflowDefinition<any, AnySchema, AnySchema>>
	governance?: GovernanceConfig<any>
	modules?: readonly HarnessModuleInspection[]
	moduleRequirements?: readonly AdapterCapability[]
}

/** Internal selector guard shared by native-rule normalization and evaluation. */
export function isSelectedGovernanceTool(toolId: string, tools: readonly string[] | undefined): boolean {
	return tools === undefined || tools.includes(toolId)
}

function normalizeNativePolicyRule<S extends BuilderState>(definition: NativePolicyRule<S>): NativePolicyRule<S> {
	if (!definition.tools || !definition.when) return definition
	const predicate = definition.when
	return {
		...definition,
		when: context => (isSelectedGovernanceTool(context.toolId, definition.tools) ? predicate(context) : false),
	}
}

function normalizeExposureRule<S extends BuilderState>(
	definition: GovernanceToolExposureRule<S>,
): GovernanceToolExposureRule<S> {
	if (!definition.tools || !definition.when) return definition
	const predicate = definition.when
	return {
		...definition,
		when: context => (isSelectedGovernanceTool(context.toolId, definition.tools) ? predicate(context) : false),
	}
}

function validateGovernanceConfiguration(value: unknown): void {
	if (!governanceConfigSchema.safeParse(value).success) {
		throw new HarnessConfigError('Governance configuration is invalid.', { reason: 'invalid_governance' })
	}
}

const moduleBuilderTargets = new WeakMap<object, { builder: Builder<any>; invocation: symbol | undefined }>()

function resolveRuntimeModels(
	requirements: ModelTypesConfig,
	bindings: Record<string, ModelRuntimeBinding>,
): ModelsConfig {
	if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) {
		throw new HarnessConfigError('Portable Harness instances require model bindings.', {
			reason: 'missing_models',
			path: 'models',
		})
	}
	const requiredAliases = Object.keys(requirements)
	const suppliedAliases = Object.keys(bindings)
	for (const alias of requiredAliases) {
		if (!(alias in bindings)) {
			throw new HarnessConfigError('A required model binding is missing.', {
				reason: 'missing_model_binding',
				path: `models.${alias}`,
				id: alias,
			})
		}
	}
	for (const alias of suppliedAliases) {
		if (!(alias in requirements)) {
			throw new HarnessConfigError('An undeclared model binding was supplied.', {
				reason: 'unexpected_model_binding',
				path: `models.${alias}`,
				id: alias,
			})
		}
	}

	const models: ModelsConfig = {}
	for (const alias of requiredAliases) {
		const requirement = requirements[alias]
		const binding = bindings[alias]
		if (!requirement || !binding || typeof binding.model !== 'string' || binding.model.length === 0 || !binding.provider) {
			throw new HarnessConfigError('A model binding requires a provider and non-empty model id.', {
				reason: 'invalid_model_binding',
				path: `models.${alias}`,
				id: alias,
			})
		}
		validateProviderMethods(alias, requirement.capabilities, binding.provider)
		models[alias] = Object.freeze({ ...binding, capabilities: Object.freeze([...requirement.capabilities]) })
	}
	return Object.freeze(models)
}

function validateProviderMethods(
	alias: string,
	capabilities: readonly ModelCapability[],
	provider: ModelProvider,
): void {
	const methods: Partial<Record<ModelCapability, keyof ModelProvider>> = {
		text: 'text',
		text_stream: 'textStream',
		object: 'object',
		object_stream: 'objectStream',
		embeddings: 'embed',
		rerank: 'rerank',
	}
	for (const capability of capabilities) {
		const method = methods[capability]
		if (method && typeof provider[method] !== 'function') {
			throw new HarnessConfigError('A model provider does not implement a required capability.', {
				reason: 'model_capability_mismatch',
				path: `models.${alias}.provider.${method}`,
				id: alias,
			})
		}
	}
}

function resolveHostToolBindings(
	tools: AuthoredToolsConfig<never>,
	bindings: Record<string, HostToolBinding>,
): ToolsConfig<never> {
	const required = Object.entries(tools).filter(([, definition]) => definition.kind === 'host')
	const requiredIds = new Set(required.map(([id]) => id))
	for (const id of requiredIds) {
		if (typeof bindings[id] !== 'function') {
			throw new HarnessConfigError('A host-tool binding is required.', {
				reason: 'missing_host_tool_binding',
				path: `hostTools.${id}`,
				id,
			})
		}
	}
	for (const id of Object.keys(bindings)) {
		if (!requiredIds.has(id)) {
			throw new HarnessConfigError('A host-tool binding was supplied for an undeclared contract.', {
				reason: 'unknown_host_tool_binding',
				path: `hostTools.${id}`,
				id,
			})
		}
	}

	return Object.fromEntries(
		Object.entries(tools).map(([id, definition]) => {
			if (definition.kind !== 'host') return [id, definition]
			const hostDefinition = definition as HostToolDefinition
			const binding = bindings[id]!
			const runtimeDefinition: TsToolDefinition<AnyModelSchema, AnySchema, never> = {
				kind: 'ts',
				description: hostDefinition.description,
				input: hostDefinition.input,
				output: hostDefinition.output,
				handler: async (context, input) => {
					const runtimeContext = context as ToolHandlerContext & { readonly hostContext?: unknown }
					if (runtimeContext.hostContext === undefined) {
						throw new ValidationError('A host-tool call requires run-scoped host context.', {
							where: 'tool_input',
							issues: { toolId: id, reason: 'missing_host_context' },
						})
					}
					const { hostContext, ...toolContext } = runtimeContext
					return binding({ ...toolContext, host: hostContext }, input)
				},
			}
			return [id, runtimeDefinition]
		}),
	) as ToolsConfig<never>
}

class Builder<S extends BuilderState> {
	private readonly options: HarnessOptions
	private readonly configured: BuilderStateInternal
	private readonly activeModuleId: string | undefined

	public constructor(options: HarnessOptions, configured: BuilderStateInternal = {}, activeModuleId?: string) {
		this.options = options
		this.configured = configured
		this.activeModuleId = activeModuleId
	}

	public use<Required extends BuilderState, Result extends BuilderState, Id extends string>(
		module: S extends Required ? HarnessModule<Required, Result, Id> : never,
	): HarnessBuilder<S & Result> {
		this.validateModule(module)
		const existing = this.configured.modules ?? []
		if (existing.some(entry => entry.id === module.id)) {
			throw new HarnessConfigError('Harness module id is already configured.', {
				reason: 'duplicate_module',
				path: 'modules',
				id: module.id,
				module_id: module.id,
			})
		}

		const invocation = Symbol(`harness-module:${module.id}`)
		const scoped = new Builder(this.options, this.configured, module.id)
		let output: HarnessModuleBuilder<Result>
		try {
			output = module.register(scoped.toModuleBuilder(scoped, invocation) as unknown as HarnessModuleBuilder<Required>)
		} catch (error) {
			throw error
		}
		const target = output && typeof output === 'object' ? moduleBuilderTargets.get(output as object) : undefined
		if (!target || target.invocation !== invocation) {
			throw new HarnessConfigError('Harness module register must return its module builder.', {
				reason: 'invalid_module',
				path: `modules.${module.id}.register`,
				id: module.id,
				module_id: module.id,
			})
		}
		const contributions = moduleContributions(this.configured, target.builder.configured)
		if (contributions.length === 0) {
			throw new HarnessConfigError('Harness module must contribute at least one definition family.', {
				reason: 'invalid_module',
				path: `modules.${module.id}`,
				id: module.id,
				module_id: module.id,
			})
		}
		const inspection: HarnessModuleInspection = Object.freeze({
			id: module.id,
			...(module.version ? { version: module.version } : {}),
			requires: Object.freeze(uniqueCapabilities(module.requires ?? [])),
			contributions: Object.freeze(
				contributions.map(contribution =>
					Object.freeze({
						kind: contribution.kind,
						ids: Object.freeze([...contribution.ids]),
					}),
				),
			),
		})
		return new Builder(this.options, {
			...target.builder.configured,
			modules: Object.freeze([...existing, inspection]),
			moduleRequirements: uniqueCapabilities([
				...(this.configured.moduleRequirements ?? []),
				...(module.requires ?? []),
			]),
		}) as unknown as HarnessBuilder<S & Result>
	}

	public telemetry(opts: TelemetryOptions): HarnessBuilder<S> {
		return this.clone({ telemetry: opts }) as unknown as HarnessBuilder<S>
	}

	public logger(logger: Logger): HarnessBuilder<S> {
		return this.clone({ logger }) as unknown as HarnessBuilder<S>
	}

	public storage(storage: HarnessStorage): HarnessBuilder<S> {
		if (this.configured.storage) {
			throw new HarnessConfigError('Harness storage is already configured.', {
				reason: 'duplicate_adapter',
				path: 'storage',
			})
		}
		validateHarnessStorage(storage)
		return this.clone({ storage }) as unknown as HarnessBuilder<S>
	}

	public sandbox(): HarnessBuilder<S & { sandboxCapabilities: readonly AdapterCapability[] }>
	public sandbox<const G extends string>(
		sandbox: undefined,
		options: SandboxBindingOptions<G>,
	): HarnessBuilder<S & { sandboxCapabilities: readonly AdapterCapability[]; sandboxGroups: readonly G[] }>
	public sandbox<const A extends Sandbox>(
		sandbox: A,
	): HarnessBuilder<S & { sandboxCapabilities: NonNullable<A['capabilities']> }>
	public sandbox<const A extends Sandbox, const G extends string>(
		sandbox: A,
		options: SandboxBindingOptions<G>,
	): HarnessBuilder<S & { sandboxCapabilities: NonNullable<A['capabilities']>; sandboxGroups: readonly G[] }>
	public sandbox(sandbox?: Sandbox, options?: SandboxBindingOptions<string>): HarnessBuilder<any> {
		if (this.configured.sandbox) {
			throw new HarnessConfigError('Sandbox is already configured.', { reason: 'duplicate_adapter', path: 'sandbox' })
		}
		const parsed = sandboxBindingOptionsSchema.safeParse(options ?? {})
		if (!parsed.success) {
			throw new HarnessConfigError('Sandbox binding options are invalid.', {
				reason: 'invalid_adapter',
				path: 'sandbox',
			})
		}
		const sandboxBinding: SandboxBindingOptions<string> = {
			...(parsed.data.groups ? { groups: parsed.data.groups } : {}),
			...(parsed.data.defaultPolicy ? { defaultPolicy: parsed.data.defaultPolicy } : {}),
			...(parsed.data.authorizeOwner ? { authorizeOwner: parsed.data.authorizeOwner } : {}),
		}
		return new Builder(
			this.options,
			{
				...this.configured,
				sandbox: sandbox ?? autoDetectSandbox(),
				...(Object.keys(sandboxBinding).length > 0 ? { sandboxBinding } : {}),
			},
			this.activeModuleId,
		)
	}

	public memory<const C extends readonly import('../ports/memory.js').MemoryCapability[]>(
		engine: MemoryEngine<C>,
	): HarnessBuilder<S>
	public memory<const C extends readonly import('../ports/memory.js').MemoryCapability[]>(
		configuration: MemoryConfiguration<C, NonNullable<S['models']>>,
	): HarnessBuilder<S>
	public memory<const C extends readonly import('../ports/memory.js').MemoryCapability[]>(
		configuration: (
			model: MemoryModelReferences<NonNullable<S['models']>>,
		) => MemoryConfiguration<C, NonNullable<S['models']>>,
	): HarnessBuilder<S>
	public memory(memory: unknown): HarnessBuilder<S> {
		if (this.configured.memory) {
			throw new HarnessConfigError('Memory engine is already configured.', {
				reason: 'duplicate_adapter',
				path: 'memory',
			})
		}
		if (typeof memory !== 'function') {
			if (!memory || typeof memory !== 'object') {
				throw new HarnessConfigError('Memory must be a MemoryEngine, MemoryConfiguration, or configuration callback.', {
					reason: 'invalid_adapter',
					path: 'memory',
				})
			}
			const engine = 'engine' in memory ? memory.engine : memory
			if (!isMemoryEngineCandidate(engine)) {
				throw new HarnessConfigError('Memory configuration requires a valid MemoryEngine.', {
					reason: 'invalid_memory_engine',
					path: 'memory.engine',
				})
			}
			validateMemoryEngine(engine)
		}
		return this.clone({ memory: memory as NonNullable<typeof this.configured.memory> }) as unknown as HarnessBuilder<S>
	}

	public workspace(workspace: DurableWorkspace): HarnessBuilder<S> {
		if (this.configured.workspace) {
			throw new HarnessConfigError('Workspace is already configured.', {
				reason: 'duplicate_adapter',
				path: 'workspace',
			})
		}
		validateDurableWorkspace(workspace)
		return this.clone({ workspace }) as unknown as HarnessBuilder<S>
	}

	public requires(capabilities: readonly AdapterCapability[]): HarnessBuilder<S> {
		return this.clone({ requiredCapabilities: uniqueCapabilities(capabilities) }) as unknown as HarnessBuilder<S>
	}

	public defaults(defaults: HarnessDefaults): HarnessBuilder<S> {
		if (
			defaults.decisionTimeoutMs !== undefined &&
			(!Number.isSafeInteger(defaults.decisionTimeoutMs) || defaults.decisionTimeoutMs <= 0)
		) {
			throw new HarnessConfigError('decisionTimeoutMs must be a positive safe integer', {
				reason: 'invalid_defaults',
				path: 'defaults.decisionTimeoutMs',
			})
		}
		if (defaults.historyWindow !== undefined && defaults.historyWindow < 0) {
			throw new HarnessConfigError('historyWindow must be >= 0', {
				reason: 'invalid_defaults',
				path: 'defaults.historyWindow',
			})
		}
		if (
			defaults.maxParallelToolCalls !== undefined &&
			(!Number.isInteger(defaults.maxParallelToolCalls) || defaults.maxParallelToolCalls < 1)
		) {
			throw new HarnessConfigError('maxParallelToolCalls must be a positive integer', {
				reason: 'invalid_defaults',
				path: 'defaults.maxParallelToolCalls',
			})
		}
		if (
			defaults.agentMaxIterations !== undefined &&
			(!Number.isInteger(defaults.agentMaxIterations) || defaults.agentMaxIterations < 1)
		) {
			throw new HarnessConfigError('agentMaxIterations must be a positive integer', {
				reason: 'invalid_defaults',
				path: 'defaults.agentMaxIterations',
			})
		}
		validateDelegationBudget(defaults.delegation?.maxChildAgentCalls, 'defaults.delegation.maxChildAgentCalls', {
			min: 0,
		})
		validateDelegationBudget(
			defaults.delegation?.maxParallelChildAgentCalls,
			'defaults.delegation.maxParallelChildAgentCalls',
			{ min: 1 },
		)
		validateDelegationBudget(defaults.delegation?.maxDepth, 'defaults.delegation.maxDepth', { min: 0 })
		if (!validateContextProjection(defaults.contextProjection)) {
			throw new HarnessConfigError('contextProjection is invalid.', {
				reason: 'invalid_context_projection',
				path: 'defaults.contextProjection',
			})
		}
		if (!validateSessionHistoryRetention(defaults.historyRetention)) {
			throw new HarnessConfigError('historyRetention is invalid.', {
				reason: 'invalid_defaults',
				path: 'defaults.historyRetention',
			})
		}
		return this.clone({ defaults }) as unknown as HarnessBuilder<S>
	}

	public requireModel<const Id extends string, const R extends ModelRequirement>(
		id: Id,
		requirement: R,
	): HarnessBuilder<S & { models: Record<Id, R & ModelAlias> }> {
		return this.registerModelRequirements({ [id]: requirement }) as never
	}

	public requireModels<const R extends ModelTypesConfig>(
		requirements: R,
	): HarnessBuilder<S & { models: RequiredModelTypes<R> }> {
		return this.registerModelRequirements(requirements) as never
	}

	private registerModelRequirements(requirements: ModelTypesConfig): HarnessBuilder<any> {
		if (this.configured.models) {
			throw new HarnessConfigError('Portable model requirements cannot be combined with concrete model aliases.', {
				reason: 'invalid_models',
				path: 'models',
			})
		}
		if (Object.keys(requirements).length === 0) {
			throw new HarnessConfigError('At least one model requirement is required.', {
				reason: 'missing_models',
				path: 'models',
			})
		}
		const current = this.configured.modelRequirements ?? {}
		for (const [alias, requirement] of Object.entries(requirements)) {
			this.validateRegistryId('models', alias)
			if (alias in current) {
				throw new HarnessConfigError(`Definition id "${alias}" is already configured in models.`, {
					reason: 'duplicate_definition',
					path: `models.${alias}`,
					id: alias,
				})
			}
			if (!Array.isArray(requirement.capabilities) || requirement.capabilities.length === 0) {
				throw new HarnessConfigError('A model requirement needs at least one capability.', {
					reason: 'invalid_models',
					path: `models.${alias}.capabilities`,
					id: alias,
				})
			}
		}
		return this.clone({ modelRequirements: Object.freeze({ ...current, ...requirements }) }) as unknown as HarnessBuilder<any>
	}

	public model<const Id extends string, const D extends ModelAlias>(
		id: Id,
		definition: D,
	): HarnessBuilder<S & { models: Record<Id, D> }> {
		return this.registerModels({ [id]: definition }) as never
	}

	public models<const M extends ModelsConfig>(models: M): HarnessBuilder<S & { models: M }> {
		return this.registerModels(models) as never
	}

	private registerModels(models: ModelsConfig): HarnessBuilder<any> {
		if (this.configured.modelRequirements) {
			throw new HarnessConfigError('Concrete model aliases cannot be combined with portable model requirements.', {
				reason: 'invalid_models',
				path: 'models',
			})
		}
		if (Object.keys(models).length === 0) {
			throw new HarnessConfigError('At least one model alias is required.', {
				reason: 'missing_models',
				path: 'models',
			})
		}
		for (const [alias, config] of Object.entries(models)) {
			this.validateRegistryId('models', alias)
			validateModelRetrySetting(config.retry, `models.${alias}.retry`)
			validateModelRetrySetting(config.defaults?.retry, `models.${alias}.defaults.retry`)
			if (!validateContextProjection(config.contextProjection)) {
				throw new HarnessConfigError('contextProjection is invalid.', {
					reason: 'invalid_context_projection',
					path: `models.${alias}.contextProjection`,
					id: alias,
				})
			}
		}
		return this.clone({ models: this.mergeDefinitions('models', models) }) as unknown as HarnessBuilder<any>
	}

	public tool<const Id extends string, const I extends AnyModelSchema, const O extends AnySchema>(
		id: Id,
		definition: TsToolDefinition<I, O, ToolContextFor<S>>,
	): HarnessBuilder<S & { tools: Record<Id, TsToolDefinition<I, O, ToolContextFor<S>>> }>
	public tool<const Id extends string, const D extends McpStdioToolDefinition | McpHttpToolDefinition>(
		id: Id,
		definition: D,
	): HarnessBuilder<S & { tools: Record<Id, D> }>
	public tool(id: string, definition: ToolDefinition<ToolContextFor<S>>): HarnessBuilder<any> {
		return this.registerTools({ [id]: definition })
	}

	public hostTool<const Id extends string, const I extends AnyModelSchema, const O extends AnySchema>(
		id: Id,
		definition: HostToolDefinition<I, O>,
	): HarnessBuilder<S & { tools: Record<Id, HostToolDefinition<I, O>> }> {
		return this.registerTools({ [id]: definition }) as never
	}

	public tools<const T extends Record<string, { input: AnyModelSchema; output: AnySchema }>>(
		tools: T & NativeToolsConfigFromSchemaMaps<ToolContextFor<S>, T>,
	): HarnessBuilder<S & { tools: NativeToolsConfigFromSchemaMaps<ToolContextFor<S>, T> }>
	public tools<const T extends Record<string, ToolSchemaFields>>(
		tools: T & ToolsConfigFromSchemaMaps<ToolContextFor<S>, T>,
	): HarnessBuilder<S & { tools: ToolsConfigFromSchemaMaps<ToolContextFor<S>, T> }>
	public tools(tools: ToolsConfig<ToolContextFor<S>>): HarnessBuilder<any> {
		return this.registerTools(tools) as never
	}

	private registerTools(tools: AuthoredToolsConfig<ToolContextFor<S>>): HarnessBuilder<any> {
		validateToolDefinitions(tools)
		for (const id of Object.keys(tools)) {
			this.validateRegistryId('tools', id)
		}
		return this.clone({ tools: this.mergeDefinitions('tools', tools) }) as unknown as HarnessBuilder<any>
	}

	public skill<const Id extends string, const D extends SkillDefinition>(
		id: Id,
		definition: D,
	): HarnessBuilder<S & { skills: Record<Id, D> }> {
		return this.registerSkills({ [id]: definition }) as never
	}

	public skills<const K extends SkillsConfig>(skills: K): HarnessBuilder<S & { skills: K }> {
		return this.registerSkills(skills) as never
	}

	private registerSkills(skills: SkillsConfig): HarnessBuilder<any> {
		for (const id of Object.keys(skills)) this.validateSkillId(id)
		return this.clone({ skills: this.mergeDefinitions('skills', skills) }) as unknown as HarnessBuilder<any>
	}

	public agent<
		const Id extends string,
		const I extends AnySchema = DefaultSchema,
		const O extends AnySchema | undefined = undefined,
	>(
		id: Id,
		definition: AgentDefinition<
			S & { models: NonNullable<S['models']>; tools: NonNullable<S['tools']>; skills: NonNullable<S['skills']> },
			I,
			O
		>,
	): HarnessBuilder<
		S & {
			agents: Record<
				Id,
				AgentDefinition<
					S & { models: NonNullable<S['models']>; tools: NonNullable<S['tools']>; skills: NonNullable<S['skills']> },
					I,
					O
				>
			>
		}
	> {
		return this.registerAgents({ [id]: definition } as Record<string, AnyAgentDefinition>) as never
	}

	public agents<const A extends Record<string, { input: AnySchema; output: AnySchema }>>(
		agents: A &
			AgentsConfigFromSchemaMaps<
				S & { models: NonNullable<S['models']>; tools: NonNullable<S['tools']>; skills: NonNullable<S['skills']> },
				A
			>,
	): HarnessBuilder<
		S & {
			agents: AgentsConfigFromSchemaMaps<
				S & { models: NonNullable<S['models']>; tools: NonNullable<S['tools']>; skills: NonNullable<S['skills']> },
				A
			>
		}
	>
	public agents<const A extends Record<string, AgentSchemaFields>>(
		agents: A &
			AgentsConfig<
				S & { models: NonNullable<S['models']>; tools: NonNullable<S['tools']>; skills: NonNullable<S['skills']> },
				A
			>,
	): HarnessBuilder<
		S & {
			agents: AgentsConfig<
				S & { models: NonNullable<S['models']>; tools: NonNullable<S['tools']>; skills: NonNullable<S['skills']> },
				A
			>
		}
	>
	public agents(agents: Record<string, AnyAgentDefinition>): HarnessBuilder<any> {
		return this.registerAgents(agents)
	}

	public workflow<
		const Id extends string,
		const I extends AnySchema = DefaultSchema,
		const O extends AnySchema = DefaultSchema,
	>(
		id: Id,
		definition: WorkflowDefinition<S & { agents: NonNullable<S['agents']> }, I, O>,
	): HarnessBuilder<S & { workflows: Record<Id, WorkflowDefinition<S & { agents: NonNullable<S['agents']> }, I, O>> }> {
		return this.registerWorkflows({ [id]: definition } as Record<
			string,
			WorkflowDefinition<any, AnySchema, AnySchema>
		>) as never
	}

	public workflows<const W extends Record<string, { input: AnySchema; output: AnySchema }>>(
		workflows: W & WorkflowsConfigFromSchemaMaps<S & { agents: NonNullable<S['agents']> }, W>,
	): HarnessBuilder<S & { workflows: WorkflowsConfigFromSchemaMaps<S & { agents: NonNullable<S['agents']> }, W> }>
	public workflows<const W extends Record<string, WorkflowSchemaFields>>(
		workflows: W & WorkflowsConfig<S & { agents: NonNullable<S['agents']> }, W>,
	): HarnessBuilder<S & { workflows: WorkflowsConfig<S & { agents: NonNullable<S['agents']> }, W> }>
	public workflows(workflows: Record<string, WorkflowDefinition<any, AnySchema, AnySchema>>): HarnessBuilder<any> {
		return this.registerWorkflows(workflows)
	}

	public governance(
		config: GovernanceConfig<S> | ((helpers: GovernanceDefinitionHelpers<S>) => GovernanceConfig<S>),
	): HarnessBuilder<S> {
		if (this.configured.governance) {
			throw new HarnessConfigError('Governance is already configured.', {
				reason: 'duplicate_adapter',
				path: 'governance',
			})
		}
		const helpers: GovernanceDefinitionHelpers<S> = {
			rule: (definition: NativePolicyRule<S>) => normalizeNativePolicyRule(definition),
			exposureRule: (definition: GovernanceToolExposureRule<S>) => normalizeExposureRule(definition),
			native: definition => ({ ...definition, kind: 'native' }),
			adapter: definition => definition,
		}
		const resolved = typeof config === 'function' ? config(helpers) : config
		validateGovernanceConfiguration(resolved)
		return this.clone({ governance: resolved }) as unknown as HarnessBuilder<S>
	}

	public define(): HarnessDefinition<S> {
		if (this.configured.models) {
			throw new HarnessConfigError('Portable definitions use requireModel or requireModels instead of concrete models.', {
				reason: 'concrete_models_in_definition',
				path: 'models',
			})
		}
		const requirements = this.configured.modelRequirements ?? {}
		this.validateToolSkillNamespace()
		this.validateAgentModelAndToolReferences(requirements)
		this.validateAgentSkillReferences(this.configured.agents ?? {})

		const name = this.options.name ?? 'agent-harness'
		const catalog = this.createDefinitionCatalog(name, requirements)
		const definitionConfig = this.configured
		const options = this.options
		return Object.freeze({
			name,
			catalog,
			$infer: Object.freeze({}) as InferTypes<S>,
			getInstance: async <Host = unknown>(config: HarnessInstanceConfig<S, Host>) => {
				const models = resolveRuntimeModels(requirements, config.models as Record<string, ModelRuntimeBinding>)
				const tools = resolveHostToolBindings(
					definitionConfig.tools ?? {},
					(config.hostTools ?? {}) as Record<string, HostToolBinding>,
				)
				const runtimeConfig: BuilderStateInternal = { ...definitionConfig, models, tools }
				if (config.logger) runtimeConfig.logger = config.logger
				if (config.telemetry) runtimeConfig.telemetry = config.telemetry
				if (config.storage) runtimeConfig.storage = config.storage
				if (config.sandbox) runtimeConfig.sandbox = config.sandbox
				if (config.sandboxBinding) runtimeConfig.sandboxBinding = config.sandboxBinding
				if (config.memory) runtimeConfig.memory = config.memory as NonNullable<BuilderStateInternal['memory']>
				if (config.workspace) runtimeConfig.workspace = config.workspace
				const runtime = new Builder<S>(options, runtimeConfig)
				return runtime.build()
			},
		})
	}

	public build(): Harness<S> {
		const models = this.configured.models ?? {}
		const unboundHostTool = Object.entries(this.configured.tools ?? {}).find(([, tool]) => tool.kind === 'host')
		if (unboundHostTool) {
			throw new HarnessConfigError('Portable host tools must be bound through definition.getInstance(...).', {
				reason: 'missing_host_tool_binding',
				path: `hostTools.${unboundHostTool[0]}`,
				id: unboundHostTool[0],
			})
		}
		this.validateToolSkillNamespace()
		this.validateSandboxPolicies()
		// Validated at build time (not in `.agents(...)`) because models may be
		// declared later in the builder chain.
		this.validateAgentModelAndToolReferences(models)
		this.validateAgentPermissions()
		this.validateGovernancePolicies()
		const modelSchemas = compileModelSchemas(
			this.configured.agents ?? {},
			(this.configured.tools ?? {}) as ToolsConfig<never>,
		)
		const sandbox = this.configured.sandbox ?? autoDetectSandbox()
		const resolvedMemory = this.resolveMemory(models)
		const memory = resolvedMemory.engine
		const storage = this.configured.storage ?? new InMemoryHarnessStorage()
		validateHarnessStorage(storage)
		if (this.configured.workspace) validateDurableWorkspace(this.configured.workspace)
		const inspection = this.resolveInspection(this.options.name ?? 'agent-harness', storage, sandbox, memory, models)
		const missing = missingCapabilities(inspection.requiredCapabilities, inspection.capabilities)
		if (missing.length > 0) {
			throw new HarnessConfigError('Required adapter capabilities are not available.', {
				reason: 'missing_required_capability',
				path: 'requires',
				id: missing.join(','),
			})
		}

		const harness = createSessionHarness<S>({
			name: this.options.name ?? 'agent-harness',
			logger: this.configured.logger ?? new JsonLogger(),
			...(this.configured.telemetry ? { telemetry: this.configured.telemetry } : {}),
			storage,
			sandbox,
			...(this.configured.sandboxBinding ? { sandboxBinding: this.configured.sandboxBinding } : {}),
			memory,
			...(resolvedMemory.embeddingAlias ? { memoryEmbeddingAlias: resolvedMemory.embeddingAlias } : {}),
			...(resolvedMemory.summary ? { memorySummary: resolvedMemory.summary } : {}),
			...(this.configured.workspace ? { workspace: this.configured.workspace } : {}),
			defaults: {
				agentMaxIterations: this.configured.defaults?.agentMaxIterations ?? 16,
				runTimeoutMs: this.configured.defaults?.runTimeoutMs ?? 600_000,
				toolTimeoutMs: this.configured.defaults?.toolTimeoutMs ?? 120_000,
				decisionTimeoutMs: this.configured.defaults?.decisionTimeoutMs ?? 10_000,
				skillTimeoutMs: this.configured.defaults?.skillTimeoutMs ?? 60_000,
				modelTimeoutMs: this.configured.defaults?.modelTimeoutMs ?? 300_000,
				maxParallelToolCalls: this.configured.defaults?.maxParallelToolCalls ?? 8,
				...(this.configured.defaults?.historyWindow !== undefined
					? { historyWindow: this.configured.defaults.historyWindow }
					: {}),
				...(this.configured.defaults?.contextProjection
					? { contextProjection: this.configured.defaults.contextProjection }
					: {}),
				...(this.configured.defaults?.historyRetention
					? { historyRetention: this.configured.defaults.historyRetention }
					: {}),
				...(this.configured.defaults?.delegation ? { delegation: this.configured.defaults.delegation } : {}),
			},
			models,
			tools: (this.configured.tools ?? {}) as NonNullable<S['tools']>,
			modelSchemas,
			skills: (this.configured.skills ?? {}) as NonNullable<S['skills']>,
			agents: (this.configured.agents ?? {}) as NonNullable<S['agents']>,
			workflows: (this.configured.workflows ?? {}) as NonNullable<S['workflows']>,
			...(this.configured.governance ? { governance: this.configured.governance as GovernanceConfig<S> } : {}),
			inspection,
		})

		return harness
	}

	private createDefinitionCatalog(
		name: string,
		requirements: ModelTypesConfig,
	): HarnessContributionCatalog<S> {
		const entry = (definition: { input?: AnySchema; output?: AnySchema; updates?: OutputUpdateMode }) =>
			Object.freeze({
				input: definition.input ?? z.string(),
				output: definition.output ?? z.string(),
				updates: definition.updates ?? 'none',
			})
		return Object.freeze({
			name,
			models: Object.freeze({ ...requirements }),
			hostTools: Object.freeze(
				Object.fromEntries(
					Object.entries(this.configured.tools ?? {})
						.filter(([, definition]) => definition.kind === 'host')
						.map(([id, definition]) => [
							id,
							Object.freeze({
								input: (definition as HostToolDefinition).input,
								output: (definition as HostToolDefinition).output,
								description: definition.description,
							}),
						]),
				),
			) as HarnessContributionCatalog<S>['hostTools'],
			agents: Object.freeze(
				Object.fromEntries(
					Object.entries(this.configured.agents ?? {}).map(([id, definition]) => [id, entry(definition)]),
				),
			) as HarnessContributionCatalog<S>['agents'],
			workflows: Object.freeze(
				Object.fromEntries(
					Object.entries(this.configured.workflows ?? {}).map(([id, definition]) => [id, entry(definition)]),
				),
			) as HarnessContributionCatalog<S>['workflows'],
		}) as HarnessContributionCatalog<S>
	}

	private resolveMemory(models: ModelsConfig): {
		engine: MemoryEngine
		embeddingAlias?: string
		summary?: { alias: string; everyTurns: number; sourceTurns: number }
	} {
		const configured = this.configured.memory
		if (!configured) return { engine: inMemoryMemoryEngine() }
		const references = Object.fromEntries(
			Object.entries(models).map(([alias, model]) => [
				alias,
				Object.freeze({ alias, capabilities: Object.freeze([...model.capabilities]) }),
			]),
		) as MemoryModelReferences<ModelsConfig>
		const definition = (typeof configured === 'function' ? configured(references) : configured) as
			| MemoryConfiguration
			| MemoryEngine
		const engine = 'engine' in definition ? definition.engine : definition
		validateMemoryEngine(engine)
		let embeddingAlias: string | undefined
		if ('engine' in definition && definition.embedding !== undefined) {
			if (!engine.capabilities.includes('memory.vector_search')) {
				throw new HarnessConfigError('Memory embedding requires an engine with memory.vector_search.', {
					reason: 'missing_required_capability',
					path: 'memory.embedding',
					id: engine.info.id,
				})
			}
			const ref =
				'model' in (definition.embedding as object)
					? (definition.embedding as { model: { alias: string } }).model
					: (definition.embedding as { alias: string })
			if (!models[ref.alias]?.capabilities.includes('embeddings')) {
				throw new HarnessConfigError('Memory embedding reference must select an embedding-capable model.', {
					reason: 'invalid_memory_model_reference',
					path: 'memory.embedding',
					id: ref.alias,
				})
			}
			embeddingAlias = ref.alias
		}
		let summary: { alias: string; everyTurns: number; sourceTurns: number } | undefined
		if ('engine' in definition && definition.summary !== undefined) {
			const advanced = definition.summary as {
				model?: { alias: string }
				alias?: string
				everyTurns?: number
				sourceTurns?: number
			}
			const ref = advanced.model ?? (advanced as { alias: string })
			if (!models[ref.alias]?.capabilities.includes('object')) {
				throw new HarnessConfigError('Memory summary reference must select an object-capable model.', {
					reason: 'invalid_memory_model_reference',
					path: 'memory.summary',
					id: ref.alias,
				})
			}
			const everyTurns = advanced.everyTurns ?? 20
			const sourceTurns = advanced.sourceTurns ?? 50
			if (
				!Number.isSafeInteger(everyTurns) ||
				everyTurns < 1 ||
				!Number.isSafeInteger(sourceTurns) ||
				sourceTurns < 1
			) {
				throw new HarnessConfigError('Memory summary intervals must be positive safe integers.', {
					reason: 'invalid_memory_summary',
					path: 'memory.summary',
				})
			}
			summary = { alias: ref.alias, everyTurns, sourceTurns }
		}
		return { engine, ...(embeddingAlias ? { embeddingAlias } : {}), ...(summary ? { summary } : {}) }
	}

	private toModuleBuilder<T extends BuilderState = S>(
		target: Builder<T> = this as unknown as Builder<T>,
		invocation?: symbol,
	): HarnessModuleBuilder<T> {
		const builder = target
		const facade = {
			model: (id: string, definition: ModelAlias) =>
				builder.toModuleBuilder(builder.registerModels({ [id]: definition }) as Builder<any>, invocation),
			models: (models: ModelsConfig) =>
				builder.toModuleBuilder(builder.registerModels(models) as Builder<any>, invocation),
			tool: (id: string, definition: ToolDefinition<ToolContextFor<T>>) =>
				builder.toModuleBuilder(builder.registerTools({ [id]: definition }) as Builder<any>, invocation),
			hostTool: (id: string, definition: HostToolDefinition) =>
				builder.toModuleBuilder(builder.registerTools({ [id]: definition }) as Builder<any>, invocation),
			tools: (tools: ToolsConfig<ToolHandlerContext<SandboxCapabilitiesFor<T>>>) =>
				builder.toModuleBuilder(builder.registerTools(tools) as Builder<any>, invocation),
			skill: (id: string, definition: SkillDefinition) =>
				builder.toModuleBuilder(builder.registerSkills({ [id]: definition }) as Builder<any>, invocation),
			skills: (skills: SkillsConfig) =>
				builder.toModuleBuilder(builder.registerSkills(skills) as Builder<any>, invocation),
			agent: (id: string, definition: AnyAgentDefinition) =>
				builder.toModuleBuilder(
					builder.agent(id, definition as never) as unknown as Builder<
						T & { agents: Record<string, AnyAgentDefinition> }
					>,
					invocation,
				),
			agents: (agents: unknown) =>
				builder.toModuleBuilder(
					builder.registerAgents(agents as Record<string, AnyAgentDefinition>) as unknown as Builder<
						T & { agents: Record<string, AnyAgentDefinition> }
					>,
					invocation,
				),
			workflow: (id: string, definition: WorkflowDefinition<any, AnySchema, AnySchema>) =>
				builder.toModuleBuilder(
					builder.workflow(id, definition as never) as unknown as Builder<
						T & { workflows: Record<string, WorkflowDefinition<any, AnySchema, AnySchema>> }
					>,
					invocation,
				),
			workflows: (workflows: unknown) =>
				builder.toModuleBuilder(
					builder.registerWorkflows(
						workflows as Record<string, WorkflowDefinition<any, AnySchema, AnySchema>>,
					) as unknown as Builder<T & { workflows: Record<string, WorkflowDefinition<any, AnySchema, AnySchema>> }>,
					invocation,
				),
		}
		moduleBuilderTargets.set(facade, { builder, invocation })
		return facade as unknown as HarnessModuleBuilder<T>
	}

	private mergeDefinitions<
		K extends 'models' | 'tools' | 'skills' | 'agents' | 'workflows',
		V extends Record<string, unknown>,
	>(family: K, incoming: V): V {
		const current = (this.configured[family] ?? {}) as Record<string, unknown>
		for (const id of Object.keys(incoming)) {
			if (id in current) {
				throw new HarnessConfigError(`Definition id "${id}" is already configured in ${family}.`, {
					reason: 'duplicate_definition',
					path: `${family}.${id}`,
					id,
					...(this.activeModuleId ? { module_id: this.activeModuleId } : {}),
				})
			}
		}
		return { ...current, ...incoming } as V
	}

	private registerAgents(agents: Record<string, AnyAgentDefinition>): HarnessBuilder<any> {
		if (Object.keys(agents).length === 0) {
			throw new HarnessConfigError('At least one agent definition is required.', {
				reason: 'invalid_agent',
				path: 'agents',
			})
		}
		for (const id of Object.keys(agents)) this.validateRegistryId('agents', id)
		const normalized = this.normalizeAgentDefinitions(agents)
		this.validateAgentStepBudgets(normalized)
		this.validateAgentSkillReferences(normalized)
		return this.clone({ agents: this.mergeDefinitions('agents', normalized) }) as unknown as HarnessBuilder<any>
	}

	private registerWorkflows(
		workflows: Record<string, WorkflowDefinition<any, AnySchema, AnySchema>>,
	): HarnessBuilder<any> {
		if (Object.keys(workflows).length === 0) {
			throw new HarnessConfigError('At least one workflow definition is required.', {
				reason: 'invalid_workflow',
				path: 'workflows',
			})
		}
		for (const id of Object.keys(workflows)) this.validateRegistryId('workflows', id)
		this.validateWorkflowDelegationPolicies(workflows)
		return this.clone({ workflows: this.mergeDefinitions('workflows', workflows) }) as unknown as HarnessBuilder<any>
	}

	private validateRegistryId(family: 'models' | 'tools' | 'agents' | 'workflows', id: string): void {
		if (
			!/^[a-z][a-z0-9_]*$/.test(id) ||
			id.length > 64 ||
			id.startsWith('harness_') ||
			id.startsWith('system_')
		) {
			throw new HarnessConfigError(
				`Invalid ${family.slice(0, -1)} id. Ids must match /^[a-z][a-z0-9_]*$/, be at most 64 characters, and must not use the reserved harness_ or system_ prefixes.`,
				{ reason: `invalid_${family.slice(0, -1)}_id`, path: `${family}.${id}`, id },
			)
		}
	}

	private validateSkillId(id: string): void {
		if (!/^(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$/.test(id)) {
			throw new SkillManifestError(
				'Skill ids must contain 1-64 lowercase ASCII letters, numbers, or hyphens with no leading, trailing, or consecutive hyphens.',
				{ reason: 'invalid_name', skill_id: id },
			)
		}
	}

	private normalizeAgentDefinitions(agents: Record<string, AnyAgentDefinition>): Record<string, AnyAgentDefinition> {
		return Object.fromEntries(
			Object.entries(agents).map(([agentId, agent]) => {
				const candidate = agent as AnyAgentDefinition & {
					guardrails?: unknown
					interceptors?: readonly AgentExecutionInterceptor[]
					maxSteps?: unknown
					prepareStep?: unknown
					stopWhen?: unknown
				}
				if (
					candidate.handler &&
					(candidate.guardrails !== undefined ||
						candidate.interceptors !== undefined ||
						candidate.maxSteps !== undefined ||
						candidate.prepareStep !== undefined ||
						candidate.stopWhen !== undefined)
				) {
					throw new HarnessConfigError('Custom-handler agents cannot configure default-loop controls.', {
						reason: 'invalid_agent',
						path: `agents.${agentId}`,
						id: agentId,
					})
				}
				if (candidate.guardrails === undefined) return [agentId, agent]

				const binding = candidate.guardrails
				if (!binding || typeof binding !== 'object' || !(agentGuardrailsBinding in binding)) {
					throw new HarnessConfigError('Agent guardrails binding is invalid.', {
						reason: 'invalid_agent',
						path: `agents.${agentId}.guardrails`,
						id: agentId,
					})
				}

				let interceptor: unknown
				try {
					interceptor = (binding as AgentGuardrailsBinding)[agentGuardrailsBinding]
				} catch {
					throw new HarnessConfigError('Agent guardrails binding is invalid.', {
						reason: 'invalid_agent',
						path: `agents.${agentId}.guardrails`,
						id: agentId,
					})
				}
				if (!isAgentExecutionInterceptor(interceptor)) {
					throw new HarnessConfigError('Agent guardrails binding is invalid.', {
						reason: 'invalid_agent',
						path: `agents.${agentId}.guardrails`,
						id: agentId,
					})
				}

				const { guardrails: _guardrails, ...definition } = candidate
				return [
					agentId,
					{
						...definition,
						interceptors: [...(candidate.interceptors ?? []), interceptor],
					} as AnyAgentDefinition,
				]
			}),
		)
	}

	private validateModule(module: unknown): void {
		const candidate = module as Partial<HarnessModule<any, any, string>> | undefined
		if (
			!candidate ||
			typeof candidate !== 'object' ||
			typeof candidate.id !== 'string' ||
			!/^[a-z][a-z0-9_.-]{1,63}$/.test(candidate.id)
		) {
			throw new HarnessConfigError('Harness module id is invalid.', {
				reason: 'invalid_module',
				path: 'modules',
				...(typeof candidate?.id === 'string' ? { id: candidate.id } : {}),
			})
		}
		if (
			candidate.version !== undefined &&
			(typeof candidate.version !== 'string' ||
				candidate.version.length === 0 ||
				candidate.version.length > 128 ||
				/[^\x20-\x7E]/.test(candidate.version))
		) {
			throw new HarnessConfigError('Harness module version is invalid.', {
				reason: 'invalid_module',
				path: `modules.${candidate.id}.version`,
				id: candidate.id,
				module_id: candidate.id,
			})
		}
		if (typeof candidate.register !== 'function') {
			throw new HarnessConfigError('Harness module register must be a function.', {
				reason: 'invalid_module',
				path: `modules.${candidate.id}.register`,
				id: candidate.id,
				module_id: candidate.id,
			})
		}
		if (candidate.requires && !Array.isArray(candidate.requires)) {
			throw new HarnessConfigError('Harness module requires must be an array.', {
				reason: 'invalid_module',
				path: `modules.${candidate.id}.requires`,
				id: candidate.id,
				module_id: candidate.id,
			})
		}
	}

	private clone(patch: Partial<BuilderStateInternal>): Builder<S> {
		return new Builder(this.options, { ...this.configured, ...patch }, this.activeModuleId)
	}

	/**
	 * Tool ids, skill ids, and built-in tool names share one model-facing
	 * namespace (spec 08 §6). A custom tool id must not collide with a built-in
	 * tool name or a skill id, and a skill id must not collide with a built-in
	 * tool name.
	 */
	private validateToolSkillNamespace(): void {
		const toolIds = Object.keys(this.configured.tools ?? {})
		const skillIds = new Set(Object.keys(this.configured.skills ?? {}))
		const builtinNames = new Set<string>(BUILTIN_TOOL_NAMES)

		for (const id of toolIds) {
			if (builtinNames.has(id)) {
				throw new SkillManifestError(`Custom tool id "${id}" collides with a built-in tool name.`, {
					reason: 'reserved_name',
					skill_id: id,
					source: 'tool',
				})
			}
			if (skillIds.has(id)) {
				throw new SkillManifestError(`Custom tool id "${id}" collides with a skill id.`, {
					reason: 'reserved_name',
					skill_id: id,
					source: 'tool',
				})
			}
		}

		for (const id of skillIds) {
			if (builtinNames.has(id)) {
				throw new SkillManifestError(`Skill id "${id}" collides with a built-in tool name.`, {
					reason: 'reserved_name',
					skill_id: id,
					source: 'skill',
				})
			}
		}
	}

	/** Rejects JavaScript-defined policies that are not part of the composition root's group vocabulary. */
	private validateSandboxPolicies(): void {
		const binding = this.configured.sandboxBinding
		const validate = (policy: unknown, path: string): void => {
			if (policy === undefined) return
			const parsed = sandboxBindingOptionsSchema.safeParse({
				...(binding?.groups ? { groups: binding.groups } : {}),
				defaultPolicy: policy,
			})
			if (!parsed.success) {
				throw new HarnessConfigError('Sandbox sharing policy is invalid.', {
					reason: 'invalid_adapter',
					path,
				})
			}
		}
		for (const [id, agent] of Object.entries(this.configured.agents ?? {})) {
			validate(agent.sandbox, `agents.${id}.sandbox`)
		}
		for (const [id, workflow] of Object.entries(this.configured.workflows ?? {})) {
			validate(workflow.sandbox, `workflows.${id}.sandbox`)
		}
	}

	private validateAgentModelAndToolReferences(models: ModelTypesConfig): void {
		const configuredTools = new Set(Object.keys(this.configured.tools ?? {}))
		for (const [agentId, agent] of Object.entries(this.configured.agents ?? {})) {
			if (!agent.handler && !(agent.model in models)) {
				throw new HarnessConfigError('Agent references an unknown model alias.', {
					reason: 'invalid_agent',
					path: `agents.${agentId}.model`,
					id: agent.model,
				})
			}
			for (const toolId of agent.tools ?? []) {
				if (!configuredTools.has(toolId)) {
					throw new HarnessConfigError('Agent references an unknown tool.', {
						reason: 'invalid_agent',
						path: `agents.${agentId}.tools`,
						id: toolId,
					})
				}
			}
			this.validateAgentInterceptorRequirements(agentId, agent, models, configuredTools)
		}
	}

	private validateAgentInterceptorRequirements(
		agentId: string,
		agent: AnyAgentDefinition,
		models: ModelTypesConfig,
		configuredTools: ReadonlySet<string>,
	): void {
		const declarations: AgentExecutionRequirementDeclaration[] = []
		for (const [index, interceptor] of (agent.interceptors ?? []).entries()) {
			if (interceptor.requirements === undefined) continue
			const path = `agents.${agentId}.interceptors.${index}.requirements`
			const parsed = agentExecutionRequirementsSchema.safeParse(interceptor.requirements)
			if (!parsed.success) {
				throw new HarnessConfigError('Agent interceptor requirements are invalid.', {
					reason: 'invalid_agent',
					path,
					id: interceptor.id,
				})
			}
			declarations.push({ path, requirements: parsed.data })
		}

		const compiled = compileAgentExecutionRequirements(declarations)
		const enabledTools = new Set<string>([...resolveEnabledBuiltinTools(agent.builtinTools), ...(agent.tools ?? [])])
		for (const tool of compiled.tools) {
			if (!configuredTools.has(tool.id) && !BUILTIN_TOOL_NAMES.includes(tool.id as BuiltinToolName)) {
				throw new HarnessConfigError('Agent interceptor requires an unknown tool.', {
					reason: 'invalid_agent',
					path: tool.path,
					id: tool.id,
				})
			}
			if (!enabledTools.has(tool.id)) {
				throw new HarnessConfigError('Agent interceptor requires a disabled tool.', {
					reason: 'invalid_agent',
					path: tool.path,
					id: tool.id,
				})
			}
		}
		for (const model of compiled.models) {
			const configured = models[model.alias]
			if (!configured) {
				throw new HarnessConfigError('Agent interceptor requires an unknown model alias.', {
					reason: 'invalid_agent',
					path: model.path,
					id: model.alias,
				})
			}
			const capabilities = model.capabilities.map(entry => entry.capability)
			if (!hasModelCapabilities(configured, capabilities)) {
				const missing = model.capabilities.find(entry => !hasModelCapabilities(configured, [entry.capability]))
				throw new HarnessConfigError('Agent interceptor requires unavailable model capabilities.', {
					reason: 'invalid_agent',
					path: missing?.path ?? model.path,
					id: model.alias,
				})
			}
		}
	}

	private validateAgentSkillReferences(agents: Record<string, AnyAgentDefinition>): void {
		const configuredSkills = new Set(Object.keys(this.configured.skills ?? {}))
		for (const [agentId, agent] of Object.entries(agents)) {
			for (const skillId of agent.skills ?? []) {
				if (!configuredSkills.has(skillId)) {
					throw new HarnessConfigError('Agent references an unknown skill.', {
						reason: 'invalid_agent',
						path: `agents.${agentId}.skills`,
						id: skillId,
					})
				}
			}
			if (
				!agent.handler &&
				(agent.skills?.length ?? 0) > 0 &&
				!resolveEnabledBuiltinTools(agent.builtinTools).includes('read')
			) {
				throw new SkillManifestError('Default-loop agents with skills must explicitly enable the read built-in tool.', {
					reason: 'skill_read_tool_missing',
					agent_id: agentId,
				})
			}
		}
	}

	private validateAgentPermissions(): void {
		for (const agent of Object.values(this.configured.agents ?? {})) {
			if (agent.permissions !== undefined && !agentPermissionsSchema.safeParse(agent.permissions).success) {
				throw new HarnessConfigError('Agent permissions are invalid or reference an unsupported tool.', {
					reason: 'invalid_agent',
				})
			}
		}
	}

	private validateAgentStepBudgets(agents: Record<string, AnyAgentDefinition>): void {
		for (const [agentId, agent] of Object.entries(agents)) {
			if (agent.maxSteps !== undefined && (!Number.isInteger(agent.maxSteps) || agent.maxSteps < 1)) {
				throw new HarnessConfigError('agent.maxSteps must be a positive integer', {
					reason: 'invalid_agent',
					path: `agents.${agentId}.maxSteps`,
					id: agentId,
				})
			}
		}
	}

	private validateWorkflowDelegationPolicies(
		workflows: Record<string, WorkflowDefinition<any, AnySchema, AnySchema>>,
	): void {
		const configuredAgents = new Set(Object.keys(this.configured.agents ?? {}))
		const configuredModels = new Set(Object.keys(this.configured.models ?? {}))

		for (const [workflowId, workflow] of Object.entries(workflows)) {
			const policy = workflow.delegation
			if (!policy) continue

			validateDelegationBudget(policy.maxChildAgentCalls, `workflows.${workflowId}.delegation.maxChildAgentCalls`, {
				min: 0,
			})
			validateDelegationBudget(
				policy.maxParallelChildAgentCalls,
				`workflows.${workflowId}.delegation.maxParallelChildAgentCalls`,
				{ min: 1 },
			)
			validateDelegationBudget(policy.maxDepth, `workflows.${workflowId}.delegation.maxDepth`, { min: 0 })

			for (const agentId of policy.agents ?? []) {
				if (!configuredAgents.has(agentId)) {
					throw new HarnessConfigError('Workflow delegation policy references an unknown agent.', {
						reason: 'invalid_workflow',
						path: `workflows.${workflowId}.delegation.agents`,
						id: agentId,
					})
				}
			}

			for (const alias of policy.modelAliases ?? []) {
				if (!configuredModels.has(alias)) {
					throw new HarnessConfigError('Workflow delegation policy references an unknown model alias.', {
						reason: 'invalid_workflow',
						path: `workflows.${workflowId}.delegation.modelAliases`,
						id: alias,
					})
				}
			}

			for (const [agentId, aliases] of Object.entries(policy.agentModelAliases ?? {})) {
				if (!configuredAgents.has(agentId)) {
					throw new HarnessConfigError('Workflow delegation policy references an unknown agent.', {
						reason: 'invalid_workflow',
						path: `workflows.${workflowId}.delegation.agentModelAliases.${agentId}`,
						id: agentId,
					})
				}
				for (const alias of aliases ?? []) {
					if (!configuredModels.has(alias)) {
						throw new HarnessConfigError('Workflow delegation policy references an unknown model alias.', {
							reason: 'invalid_workflow',
							path: `workflows.${workflowId}.delegation.agentModelAliases.${agentId}`,
							id: alias,
						})
					}
				}
			}
		}
	}

	private validateGovernancePolicies(): void {
		const governance = this.configured.governance
		const permissionApprovalRequired = Object.values(this.configured.agents ?? {}).some(agent =>
			Object.values(agent.permissions ?? {}).some(
				permission =>
					permission === 'require_approval' ||
					(typeof permission === 'object' && permission?.mode === 'require_approval'),
			),
		)
		if (!governance) {
			if (permissionApprovalRequired) {
				throw new HarnessConfigError('Permission approval requires a governance approval provider.', {
					reason: 'invalid_governance',
					path: 'governance.approval',
				})
			}
			return
		}
		validateGovernanceConfiguration(governance)
		const policies = governance.policies ?? []
		const exposureRules = governance.exposure?.rules ?? []
		if (policies.length === 0 && exposureRules.length === 0 && !governance.approval) {
			throw new HarnessConfigError('Governance requires an execution policy, exposure rule, or approval provider.', {
				reason: 'invalid_governance',
				path: 'governance',
			})
		}
		if (permissionApprovalRequired && !governance.approval) {
			throw new HarnessConfigError('Permission approval requires a governance approval provider.', {
				reason: 'invalid_governance',
				path: 'governance.approval',
			})
		}

		const configuredTools = new Set<string>([...BUILTIN_TOOL_NAMES, ...Object.keys(this.configured.tools ?? {})])
		const policyIds = new Set<string>()
		for (const policy of policies) {
			if (policyIds.has(policy.id)) {
				throw new HarnessConfigError('Governance policy ids must be unique.', { reason: 'invalid_governance' })
			}
			policyIds.add(policy.id)
			if ('kind' in policy && policy.kind === 'native') {
				const ruleIds = new Set<string>()
				for (const rule of policy.rules) {
					if (rule.effect === 'require_approval' && governance.mode !== 'shadow' && !governance.approval) {
						throw new HarnessConfigError('Governance approval rules require an approval provider.', {
							reason: 'invalid_governance',
							path: 'governance.approval',
						})
					}
					if (ruleIds.has(rule.id)) {
						throw new HarnessConfigError('Governance rule ids must be unique within a policy.', {
							reason: 'invalid_governance',
						})
					}
					ruleIds.add(rule.id)
					for (const toolId of rule.tools ?? []) {
						if (!configuredTools.has(toolId)) {
							throw new HarnessConfigError('Governance policy references an unknown tool.', {
								reason: 'invalid_governance',
							})
						}
					}
				}
			}
		}

		const exposureRuleIds = new Set<string>()
		for (const rule of exposureRules) {
			if (exposureRuleIds.has(rule.id)) {
				throw new HarnessConfigError('Governance exposure rule ids must be unique.', { reason: 'invalid_governance' })
			}
			exposureRuleIds.add(rule.id)
			for (const toolId of rule.tools ?? []) {
				if (!configuredTools.has(toolId)) {
					throw new HarnessConfigError('Governance exposure rule references an unknown tool.', {
						reason: 'invalid_governance',
					})
				}
			}
		}
	}

	private resolveInspection(
		name: string,
		storage: HarnessStorage,
		sandbox: Sandbox,
		memory: MemoryEngine,
		models: ModelsConfig,
	): HarnessInspection {
		const adapters: AdapterInspection[] = []
		adapters.push({
			kind: 'storage',
			id: storage.info.id,
			capabilities: uniqueCapabilities(storage.capabilities),
			metadata: {
				packageName: storage.info.packageName,
				...(storage.info.version ? { version: storage.info.version } : {}),
			},
		})
		const sandboxCapabilities = hasAdapterCapabilities(sandbox) ? uniqueCapabilities(sandbox.capabilities) : []
		adapters.push({
			kind: 'sandbox',
			id: getAdapterId(sandbox, 'sandbox'),
			capabilities: sandboxCapabilities,
		})
		adapters.push({
			kind: 'memory',
			id: memory.info.id,
			capabilities: uniqueCapabilities(memory.capabilities),
			metadata: {
				packageName: memory.info.packageName,
				...(memory.info.version ? { version: memory.info.version } : {}),
			},
		})

		if (this.configured.workspace) {
			adapters.push({
				kind: 'workspace',
				id: this.configured.workspace.info.id,
				capabilities: uniqueCapabilities(this.configured.workspace.info.capabilities),
				metadata: {
					packageName: this.configured.workspace.info.packageName,
					policy: this.configured.workspace.info.policy,
				},
			})
		}

		for (const [alias, model] of Object.entries(models)) {
			adapters.push({
				kind: 'model',
				id: alias,
				capabilities: [],
				metadata: {
					providerId: model.provider.id,
					genAiSystem: model.provider.genAiSystem,
					model: model.model,
					modelCapabilities: model.capabilities,
					...(model.provider.info ? { providerInfo: model.provider.info } : {}),
				},
			})
		}

		const capabilities = uniqueCapabilities(adapters.flatMap(adapter => adapter.capabilities))
		const grepRequiresTextSearch = Object.values(this.configured.agents ?? {})
			.some(agent => resolveEnabledBuiltinTools(agent.builtinTools).includes('grep'))
		return {
			name,
			capabilities,
			requiredCapabilities: uniqueCapabilities([
				...(this.configured.requiredCapabilities ?? []),
				...(this.configured.moduleRequirements ?? []),
				...(grepRequiresTextSearch ? ['sandbox.text_search' as const] : []),
			]),
			adapters: Object.freeze(
				adapters.map(adapter =>
					Object.freeze({
						...adapter,
						capabilities: Object.freeze([...adapter.capabilities]),
						...(adapter.metadata ? { metadata: Object.freeze({ ...adapter.metadata }) } : {}),
					}),
				),
			),
			modules: Object.freeze([...(this.configured.modules ?? [])]),
		}
	}
}

function isAgentExecutionInterceptor(value: unknown): value is AgentExecutionInterceptor {
	if (!value || typeof value !== 'object') return false
	const interceptor = value as Record<string, unknown>
	if (typeof interceptor['id'] !== 'string' || interceptor['id'].length === 0) return false
	return ['beforeInput', 'beforeModel', 'afterModel', 'beforeTool', 'afterTool', 'beforeOutput'].every(
		hook => interceptor[hook] === undefined || typeof interceptor[hook] === 'function',
	)
}

function isMemoryEngineCandidate(value: unknown): value is MemoryEngine {
	return Boolean(
		value &&
			typeof value === 'object' &&
			'info' in value &&
			'capabilities' in value &&
			'get' in value &&
			'put' in value &&
			'delete' in value &&
			'list' in value,
	)
}

function moduleContributions(
	before: BuilderStateInternal,
	after: BuilderStateInternal,
): Array<{ kind: 'model' | 'tool' | 'skill' | 'agent' | 'workflow'; ids: string[] }> {
	const families: ReadonlyArray<
		readonly ['models' | 'tools' | 'skills' | 'agents' | 'workflows', 'model' | 'tool' | 'skill' | 'agent' | 'workflow']
	> = [
		['models', 'model'],
		['tools', 'tool'],
		['skills', 'skill'],
		['agents', 'agent'],
		['workflows', 'workflow'],
	]
	return families.flatMap(([family, kind]) => {
		const previous = new Set(Object.keys((before[family] ?? {}) as Record<string, unknown>))
		const ids = Object.keys((after[family] ?? {}) as Record<string, unknown>).filter(id => !previous.has(id))
		return ids.length > 0 ? [{ kind, ids }] : []
	})
}

function getAdapterId(adapter: unknown, fallback: string): string {
	if (adapter && typeof adapter === 'object' && typeof (adapter as { id?: unknown }).id === 'string') {
		return (adapter as { id: string }).id
	}
	return fallback
}

function validateDelegationBudget(value: number | undefined, path: string, opts: { min: number }): void {
	if (value === undefined) return
	if (!Number.isInteger(value) || value < opts.min) {
		throw new HarnessConfigError(`${path} must be an integer >= ${opts.min}`, {
			reason: 'invalid_defaults',
			path,
		})
	}
}

/**
 * Creates the chainable harness builder used to define a harness system.
 *
 * Application code should compose models, tools, skills, agents, and workflows here,
 * build the harness, and then execute work exclusively through `harness.getSession(...)`.
 *
 * @example
 * ```ts
 * const harness = defineHarness()
 *   .models({ fast: { provider, model: 'gpt-4.1-mini', capabilities: ['object'] } })
 *   .agent('summarize', { model: 'fast', instructions: 'Summarize the input.' })
 *   .workflow('summarize_ticket', {
 *     input: z.object({ ticket: z.string() }),
 *     output: z.string(),
 *     delegation: { agents: ['summarize'] },
 *     handler: (ctx) => ctx.agents.summarize(ctx.input.ticket)
 *   })
 *   .build()
 *
 * const session = await harness.getSession('ticket-123')
 * const summary = await session.workflows.summarize_ticket.run({ ticket: 'Cannot log in' })
 * ```
 */
export function defineHarness(opts: HarnessOptions = {}): HarnessBuilder<{}> {
	return new Builder(opts) as unknown as HarnessBuilder<{}>
}
