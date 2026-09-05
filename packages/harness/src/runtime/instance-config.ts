import { HarnessConfigError } from '../errors/index.js'
import type { TelemetryOptions } from '../harness/defineHarness.js'
import type { Logger } from '../logger/index.js'
import { validateContextProjection } from '../context-projection.js'
import { validateModelRetrySetting } from '../models/retry-policy.js'
import type { AgentAdmission } from '../ports/agent-admission.js'
import type { ArtifactStore } from '../ports/artifact-store.js'
import type { AdapterCapability } from '../ports/capabilities.js'
import type { MemoryEngine } from '../ports/memory/types.js'
import { validateMemoryEngine } from '../ports/memory/validation.js'
import type { ModelAdmission } from '../ports/model-admission.js'
import type { ModelAlias, ModelCapability, ModelProvider } from '../ports/model-provider.js'
import type { DurableWorkspace } from '../ports/workspace.js'
import { validateDurableWorkspace } from '../ports/workspace.js'
import type { Sandbox, SpawnCapableSandbox } from '../sandbox/index.js'
import { sandboxBindingOptionsSchema, type SandboxBindingOptions } from '../sandbox/ownership.js'
import type { HarnessStorage } from '../storage/types.js'
import { validateHarnessStorage } from '../storage/types.js'
import type { SkillRuntimeId } from '../definitions/types.js'
import type { RuntimeRequirements } from './runtime-requirements.js'

/** Runtime model selection without graph-derived capabilities. */
export type ModelRuntimeBinding = Readonly<Omit<ModelAlias, 'capabilities'>>

/** Runtime-only transport configuration for one MCP server. */
export type McpBinding =
	| Readonly<{ transport: 'http'; url: string; headers?: Readonly<Record<string, string>> }>
	| Readonly<{
		transport: 'stdio'
		command: string
		args?: readonly string[]
		env?: Readonly<Record<string, string>>
		sandbox: SpawnCapableSandbox
	}>

export type HasMembers<Values extends readonly unknown[]> = [Values[number]] extends [never] ? false : true
export type Or<Left extends boolean, Right extends boolean> = true extends Left | Right ? true : false
export type RequiredField<Needed extends boolean, Key extends PropertyKey, Value> = Needed extends true
	? Readonly<{ [Field in Key]: Value }>
	: Readonly<{ [Field in Key]?: never }>
export type OptionalField<Needed extends boolean, Key extends PropertyKey, Value> = Needed extends true
	? Readonly<{ [Field in Key]?: Value }>
	: Readonly<{ [Field in Key]?: never }>

type ModelAliases<Requirements extends RuntimeRequirements> = keyof Requirements['models'] & string
export type ModelFields<Requirements extends RuntimeRequirements> =
	[ModelAliases<Requirements>] extends [never]
		? Readonly<{ model?: never; models?: never }>
		: [ModelAliases<Requirements>] extends ['primary']
			? ['primary'] extends [ModelAliases<Requirements>]
				? Readonly<{ model: ModelRuntimeBinding; models?: never }>
				: never
			: Readonly<{
				model?: never
				models: Readonly<{ [Alias in ModelAliases<Requirements>]: ModelRuntimeBinding }>
			}>

export type SandboxBinding<Requirements extends RuntimeRequirements> = Sandbox
	& (HasMembers<Requirements['sandbox']['capabilities']> extends true
		? Readonly<{ capabilities: readonly AdapterCapability[] }>
		: object)
	& (HasMembers<Requirements['skillRuntimes']> extends true
		? Readonly<{ runtimes: readonly SkillRuntimeId[] }>
		: object)

/** Exact runtime configuration projected from a compiled definition graph. */
type HarnessSandboxBindingOptions<
	Requirements extends RuntimeRequirements,
	ConfiguredGroups extends readonly string[],
> = Exclude<Requirements['sandbox']['requiredGroups'][number], ConfiguredGroups[number]> extends never
	? Readonly<Omit<SandboxBindingOptions<NoInfer<ConfiguredGroups[number]>>, 'groups'> & (
		[Requirements['sandbox']['requiredGroups'][number]] extends [never]
			? { readonly groups?: ConfiguredGroups }
			: { readonly groups: ConfiguredGroups }
	)>
	: never

type SandboxBindingOptionsField<Requirements extends RuntimeRequirements, ConfiguredGroups extends readonly string[]> =
	[Requirements['sandbox']['requiredGroups'][number]] extends [never]
		? Readonly<{ sandboxBinding?: HarnessSandboxBindingOptions<Requirements, ConfiguredGroups> }>
		: Readonly<{ sandboxBinding: HarnessSandboxBindingOptions<Requirements, ConfiguredGroups> }>

type SandboxFields<Requirements extends RuntimeRequirements, ConfiguredGroups extends readonly string[]> =
	Requirements['sandbox']['required'] extends true
		? Readonly<{ sandbox: SandboxBinding<Requirements> }> & SandboxBindingOptionsField<Requirements, ConfiguredGroups>
		: Readonly<{ sandbox?: never; sandboxBinding?: never }>

export type HarnessInstanceConfig<
	Requirements extends RuntimeRequirements,
	ConfiguredGroups extends readonly string[] = readonly [],
> =
	[Requirements['hostTools'][number]] extends [never]
		? Readonly<
			ModelFields<Requirements>
			& RequiredField<HasMembers<Requirements['mcpServers']>, 'mcp', Readonly<{
				[ServerId in Requirements['mcpServers'][number]]: McpBinding
			}>>
			& RequiredField<Requirements['storage']['durable'], 'storage', HarnessStorage>
			& RequiredField<Or<
				HasMembers<Requirements['memory']['capabilities']>,
				HasMembers<Requirements['memory']['modelAliases']>
			>, 'memory', MemoryEngine>
			& SandboxFields<Requirements, ConfiguredGroups>
			& RequiredField<Requirements['workspace'], 'workspace', DurableWorkspace>
			& RequiredField<Requirements['artifacts'], 'artifacts', ArtifactStore>
			& Readonly<{
				agentAdmission?: AgentAdmission
				admission?: ModelAdmission
				logger?: Logger
				telemetry?: TelemetryOptions
			}>
		>
		: never

/** @internal Frozen, normalized runtime bindings ready for later instance assembly. */
export interface ValidatedHarnessInstanceBindings {
	readonly models: Readonly<Record<string, Readonly<ModelAlias>>>
	readonly mcp?: Readonly<Record<string, McpBinding>>
	readonly storage?: HarnessStorage
	readonly memory?: MemoryEngine
	readonly sandbox?: Sandbox
	readonly sandboxBinding?: Readonly<SandboxBindingOptions<string>>
	readonly workspace?: DurableWorkspace
	readonly artifacts?: ArtifactStore
	readonly agentAdmission?: AgentAdmission
	readonly admission?: ModelAdmission
	readonly logger?: Logger
	readonly telemetry?: Readonly<TelemetryOptions>
}

type PlainRecord = Record<string, unknown>
const TOP_LEVEL_KEYS = Object.freeze([
	'admission', 'agentAdmission', 'artifacts', 'logger', 'mcp', 'memory', 'model', 'models',
	'sandbox', 'sandboxBinding', 'storage', 'telemetry', 'workspace',
])
const MODEL_KEYS = Object.freeze([
	'contextProjection', 'credentialScope', 'defaults', 'model', 'provider', 'providerOptions', 'retry',
])
const MODEL_METHODS: Readonly<Partial<Record<ModelCapability, readonly (keyof ModelProvider)[]>>> = Object.freeze({
	text: ['text'], text_stream: ['textStream'], object: ['object'], object_stream: ['objectStream'],
	embeddings: ['embed'], rerank: ['rerank'], image_generation: ['image'], speech_generation: ['speech'],
	video_generation: ['video', 'videoStream'],
})
const MODEL_CAPABILITIES: readonly ModelCapability[] = Object.freeze([
	'text', 'text_stream', 'object', 'object_stream', 'tool_use', 'vision_input', 'audio_input', 'file_input',
	'embeddings', 'rerank', 'image_generation', 'speech_generation', 'video_generation',
])
const SANDBOX_CAPABILITIES = Object.freeze([
	'sandbox.fs', 'sandbox.text_search', 'sandbox.exec', 'sandbox.persistent_fs', 'sandbox.workspace_binding',
	'sandbox.snapshot', 'sandbox.resume', 'sandbox.hibernate', 'sandbox.spawn', 'sandbox.live_process_preservation',
	'sandbox.readonly_mount',
] as const)
const SKILL_RUNTIMES = Object.freeze(['node', 'python', 'shell'] as const)

/** @internal Pure, atomic runtime-binding validation. */
export function validateHarnessInstanceConfig(
	requirements: RuntimeRequirements,
	value: unknown,
): ValidatedHarnessInstanceBindings {
	if (requirements.hostTools.length > 0) fail('standalone_host_tools_unsupported', 'hostTools')
	if (!isPlainRecord(value)) fail('invalid_instance_config', 'config')
	const config = value
	unknownKey(config, TOP_LEVEL_KEYS, '')

	const aliases = Object.keys(requirements.models).sort()
	const hasModel = own(config, 'model')
	const hasModels = own(config, 'models')
	if (hasModel && hasModels) fail('invalid_instance_config', 'model')
	let selected: Record<string, unknown> = {}
	if (aliases.length === 0) {
		if (hasModel) fail('unexpected_runtime_binding', 'model')
		if (hasModels) fail('unexpected_runtime_binding', 'models')
	} else if (aliases.length === 1 && aliases[0] === 'primary') {
		if (hasModels) fail('unexpected_runtime_binding', 'models')
		if (!hasModel) fail('missing_runtime_binding', 'model')
		selected = { primary: config['model'] }
	} else {
		if (hasModel) fail('unexpected_runtime_binding', 'model')
		if (!hasModels) fail('missing_runtime_binding', 'models')
		if (!isPlainRecord(config['models'])) fail('invalid_runtime_binding', 'models')
		const supplied = config['models']
		validateExactKeys(supplied, aliases, 'models')
		selected = supplied
	}

	const models: Record<string, Readonly<ModelAlias>> = {}
	for (const alias of aliases) {
		const path = aliases.length === 1 && alias === 'primary' ? 'model' : `models.${alias}`
		models[alias] = validateModelBinding(selected[alias], requirements.models[alias]!.capabilities, path)
	}

	const groups = [
		['mcp', requirements.mcpServers.length > 0],
		['storage', requirements.storage.durable],
		['memory', requirements.memory.capabilities.length > 0 || requirements.memory.modelAliases.length > 0],
		['sandbox', requirements.sandbox.required],
		['workspace', requirements.workspace],
		['artifacts', requirements.artifacts],
	] as const
	for (const [key, needed] of groups) {
		if (needed && !own(config, key)) fail('missing_runtime_binding', key)
		if (!needed && own(config, key)) fail('unexpected_runtime_binding', key)
	}
	const needsSandbox = requirements.sandbox.required
	if (!needsSandbox && own(config, 'sandboxBinding')) fail('unexpected_runtime_binding', 'sandboxBinding')
	if (requirements.sandbox.requiredGroups.length > 0 && !own(config, 'sandboxBinding')) fail('missing_runtime_binding', 'sandboxBinding')

	const result: Record<string, unknown> = { models: Object.freeze(models) }
	if (own(config, 'mcp')) result['mcp'] = validateMcp(config['mcp'], requirements.mcpServers)
	if (own(config, 'storage')) result['storage'] = validateStorage(config['storage'], requirements.storage.durable)
	if (own(config, 'memory')) result['memory'] = validateMemory(config['memory'], requirements.memory.capabilities)
	if (own(config, 'sandbox')) result['sandbox'] = validateSandbox(config['sandbox'], requirements.sandbox.capabilities, requirements.skillRuntimes, 'sandbox')
	if (own(config, 'sandboxBinding')) result['sandboxBinding'] = validateSandboxBinding(config['sandboxBinding'], requirements.sandbox.requiredGroups)
	if (own(config, 'workspace')) result['workspace'] = validateWorkspace(config['workspace'])
	if (own(config, 'artifacts')) result['artifacts'] = validateArtifactStore(config['artifacts'])
	if (own(config, 'agentAdmission')) result['agentAdmission'] = validateAdmission(config['agentAdmission'], 'agentAdmission')
	if (own(config, 'admission')) result['admission'] = validateAdmission(config['admission'], 'admission')
	if (own(config, 'logger')) result['logger'] = validateLogger(config['logger'])
	if (own(config, 'telemetry')) result['telemetry'] = validateTelemetry(config['telemetry'])
	return Object.freeze(result) as unknown as ValidatedHarnessInstanceBindings
}

function validateSandboxBinding(value: unknown, requiredGroups: readonly string[]): Readonly<SandboxBindingOptions<string>> {
	if (!isPlainRecord(value)) fail('invalid_runtime_binding', 'sandboxBinding')
	const additional = value['groups']
	if (additional !== undefined && (!Array.isArray(additional) || additional.some(group => typeof group !== 'string'))) {
		fail('invalid_runtime_binding', 'sandboxBinding.groups')
	}
	const configuredGroups = additional as readonly string[] | undefined
	if (requiredGroups.some(group => !configuredGroups?.includes(group))) fail('invalid_runtime_binding', 'sandboxBinding.groups')
	const parsed = sandboxBindingOptionsSchema.safeParse(value)
	if (!parsed.success) fail('invalid_runtime_binding', 'sandboxBinding')
	const data = parsed.data
	return Object.freeze({
		...(data.groups === undefined ? {} : { groups: Object.freeze([...data.groups]) }),
		...(data.defaultPolicy === undefined ? {} : { defaultPolicy: typeof data.defaultPolicy === 'string'
			? data.defaultPolicy : Object.freeze({ group: data.defaultPolicy.group }) }),
		...(data.authorizeOwner === undefined ? {} : { authorizeOwner: data.authorizeOwner }),
	})
}

function validateModelBinding(value: unknown, capabilities: readonly ModelCapability[], path: string): Readonly<ModelAlias> {
	if (!isPlainRecord(value)) fail('invalid_runtime_binding', path)
	unknownKey(value, MODEL_KEYS, path)
	if (!own(value, 'provider') || !isObject(value['provider'])) fail('invalid_runtime_binding', `${path}.provider`)
	const provider = value['provider'] as unknown as ModelProvider
	if (!nonempty(provider.id)) fail('invalid_runtime_binding', `${path}.provider.id`)
	if (!nonempty(provider.genAiSystem)) fail('invalid_runtime_binding', `${path}.provider.genAiSystem`)
	if (!nonempty(value['model'])) fail('invalid_runtime_binding', `${path}.model`)
	for (const capability of [...capabilities].sort()) {
		for (const method of MODEL_METHODS[capability] ?? []) {
			if (typeof provider[method] !== 'function') fail('model_capability_mismatch', `${path}.provider.${String(method)}`)
		}
	}
	validateProviderMetadata(provider, value['model'], capabilities, path)
	if (value['credentialScope'] !== undefined && !nonempty(value['credentialScope'])) fail('invalid_runtime_binding', `${path}.credentialScope`)
	if (value['providerOptions'] !== undefined && !isPlainRecord(value['providerOptions'])) fail('invalid_runtime_binding', `${path}.providerOptions`)
	if (value['retry'] !== undefined) validateRetry(value['retry'], `${path}.retry`)
	if (value['contextProjection'] !== undefined) validateProjection(value['contextProjection'], `${path}.contextProjection`)
	if (value['defaults'] !== undefined) validateDefaults(value['defaults'], `${path}.defaults`)
	const normalized: Record<string, unknown> = { provider, model: value['model'], capabilities: Object.freeze([...capabilities]) }
	for (const key of ['credentialScope', 'defaults', 'retry', 'contextProjection', 'providerOptions'] as const) {
		if (value[key] !== undefined) normalized[key] = snapshot(value[key], `${path}.${key}`)
	}
	return Object.freeze(normalized) as unknown as Readonly<ModelAlias>
}

function validateProviderMetadata(provider: ModelProvider, model: unknown, capabilities: readonly ModelCapability[], path: string): void {
	if (provider.info === undefined) return
	if (!isObject(provider.info) || !nonempty(provider.info.providerId) || !nonempty(provider.info.genAiSystem)) {
		fail('invalid_runtime_binding', `${path}.provider.info`)
	}
	if (provider.info.models === undefined) return
	if (!isObject(provider.info.models)) fail('invalid_runtime_binding', `${path}.provider.info.models`)
	const descriptor = provider.info.models[String(model)]
	if (!isObject(descriptor) || !Array.isArray(descriptor['capabilities'])) fail('model_capability_mismatch', `${path}.provider.info.models.${String(model)}`)
	if (descriptor['capabilities'].some(capability => typeof capability !== 'string' || !MODEL_CAPABILITIES.includes(capability as ModelCapability))) fail('invalid_runtime_binding', `${path}.provider.info.models.${String(model)}.capabilities`)
	for (const capability of [...capabilities].sort()) {
		if (!(descriptor['capabilities'] as unknown[]).includes(capability)) {
			fail('model_capability_mismatch', `${path}.provider.info.models.${String(model)}.capabilities`)
		}
	}
}

function validateDefaults(value: unknown, path: string): void {
	if (!isPlainRecord(value)) fail('invalid_runtime_binding', path)
	unknownKey(value, ['maxTokens', 'parallelToolCalls', 'providerOptions', 'retry', 'stopSequences', 'temperature', 'topP'], path)
	for (const key of ['temperature', 'topP'] as const) if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) fail('invalid_runtime_binding', `${path}.${key}`)
	if (value['maxTokens'] !== undefined && (!Number.isInteger(value['maxTokens']) || (value['maxTokens'] as number) <= 0)) fail('invalid_runtime_binding', `${path}.maxTokens`)
	if (value['parallelToolCalls'] !== undefined && typeof value['parallelToolCalls'] !== 'boolean') fail('invalid_runtime_binding', `${path}.parallelToolCalls`)
	if (value['stopSequences'] !== undefined && (!Array.isArray(value['stopSequences']) || value['stopSequences'].some(item => typeof item !== 'string'))) fail('invalid_runtime_binding', `${path}.stopSequences`)
	if (value['providerOptions'] !== undefined && !isPlainRecord(value['providerOptions'])) fail('invalid_runtime_binding', `${path}.providerOptions`)
	if (value['retry'] !== undefined) validateRetry(value['retry'], `${path}.retry`)
}

function validateRetry(value: unknown, path: string): void {
	if (typeof value === 'boolean') return
	if (!isPlainRecord(value)) fail('invalid_runtime_binding', path)
	unknownKey(value, [
		'longRetry', 'maxActiveDelayMs', 'maxActiveElapsedMs', 'maxAttempts', 'maxDeferredDelayMs',
		'maxDelayMs', 'minDelayMs', 'respectRetryAfter', 'retryOn',
	], path)
	if (value['retryOn'] !== undefined) {
		if (!isPlainRecord(value['retryOn'])) fail('invalid_runtime_binding', `${path}.retryOn`)
		unknownKey(value['retryOn'], ['network', 'rateLimit', 'serverError', 'timeout'], `${path}.retryOn`)
	}
	if (value['respectRetryAfter'] !== undefined && typeof value['respectRetryAfter'] !== 'boolean') fail('invalid_runtime_binding', `${path}.respectRetryAfter`)
	wrapInvalid(() => validateModelRetrySetting(value as ModelAlias['retry'], path), path)
}

function validateProjection(value: unknown, path: string): void {
	if (!isPlainRecord(value)) fail('invalid_runtime_binding', path)
	unknownKey(value, ['toolResultPruner'], path)
	if (value['toolResultPruner'] !== undefined) {
		if (!isPlainRecord(value['toolResultPruner'])) fail('invalid_runtime_binding', `${path}.toolResultPruner`)
		unknownKey(value['toolResultPruner'], ['headBytes', 'marker', 'maxBytes', 'tailBytes'], `${path}.toolResultPruner`)
	}
	if (!validateContextProjection(value as ModelAlias['contextProjection'])) fail('invalid_runtime_binding', path)
}

function validateMcp(value: unknown, ids: readonly string[]): Readonly<Record<string, McpBinding>> {
	if (!isPlainRecord(value)) fail('invalid_runtime_binding', 'mcp')
	validateExactKeys(value, ids, 'mcp')
	const result: Record<string, McpBinding> = {}
	for (const id of [...ids].sort()) result[id] = validateMcpBinding(value[id], `mcp.${id}`)
	return Object.freeze(result)
}

function validateMcpBinding(value: unknown, path: string): McpBinding {
	if (!isPlainRecord(value)) fail('invalid_runtime_binding', path)
	if (value['transport'] === 'http') {
		unknownKey(value, ['headers', 'transport', 'url'], path)
		if (!nonempty(value['url']) || !isHttpUrl(value['url'])) fail('invalid_runtime_binding', `${path}.url`)
		const result: Record<string, unknown> = { transport: 'http', url: value['url'] }
		if (value['headers'] !== undefined) result['headers'] = stringRecord(value['headers'], `${path}.headers`)
		return Object.freeze(result) as unknown as McpBinding
	}
	if (value['transport'] === 'stdio') {
		unknownKey(value, ['args', 'command', 'env', 'sandbox', 'transport'], path)
		if (!nonempty(value['command'])) fail('invalid_runtime_binding', `${path}.command`)
		if (value['args'] !== undefined && (!Array.isArray(value['args']) || value['args'].some(item => typeof item !== 'string'))) fail('invalid_runtime_binding', `${path}.args`)
		const result: Record<string, unknown> = { transport: 'stdio', command: value['command'] }
		if (value['args'] !== undefined) result['args'] = Object.freeze([...value['args']])
		if (value['env'] !== undefined) result['env'] = stringRecord(value['env'], `${path}.env`)
		result['sandbox'] = validateSandbox(value['sandbox'], ['sandbox.spawn'], [], `${path}.sandbox`)
		return Object.freeze(result) as unknown as McpBinding
	}
	fail('invalid_runtime_binding', `${path}.transport`)
}

function validateStorage(value: unknown, durable: boolean): HarnessStorage {
	if (!isObject(value)) fail('invalid_runtime_binding', 'storage')
	wrapInvalid(() => validateHarnessStorage(value as unknown as HarnessStorage), 'storage')
	if (durable && (!(value['capabilities'] as unknown[]).includes('storage.persistent') || !isObject(value['info']) || !(value['info']['capabilities'] as unknown[]).includes('storage.persistent'))) {
		fail('missing_required_capability', 'storage.capabilities')
	}
	return value as unknown as HarnessStorage
}

function validateMemory(value: unknown, capabilities: readonly string[]): MemoryEngine {
	if (!isObject(value)) fail('invalid_runtime_binding', 'memory')
	wrapInvalid(() => validateMemoryEngine(value as unknown as MemoryEngine), 'memory')
	for (const capability of [...capabilities].sort()) if (!(value['capabilities'] as unknown[]).includes(capability)) fail('missing_required_capability', 'memory.capabilities')
	return value as unknown as MemoryEngine
}

function validateSandbox(value: unknown, capabilities: readonly string[], runtimes: readonly string[], path: string): Sandbox {
	if (!isObject(value)) fail('invalid_runtime_binding', path)
	for (const key of ['registerOwner', 'open', 'terminate'] as const) if (typeof value[key] !== 'function') fail('invalid_runtime_binding', `${path}.${key}`)
	if (!isObject(value['administration'])) fail('invalid_runtime_binding', `${path}.administration`)
	for (const method of ['list', 'purge', 'sweep', 'deleteSnapshot'] as const) if (typeof value['administration'][method] !== 'function') fail('invalid_runtime_binding', `${path}.administration.${method}`)
	if (value['capabilities'] !== undefined && (!Array.isArray(value['capabilities']) || value['capabilities'].some(item => typeof item !== 'string' || !SANDBOX_CAPABILITIES.includes(item as typeof SANDBOX_CAPABILITIES[number])))) fail('invalid_runtime_binding', `${path}.capabilities`)
	if (Array.isArray(value['capabilities']) && new Set(value['capabilities']).size !== value['capabilities'].length) fail('invalid_runtime_binding', `${path}.capabilities`)
	if (capabilities.length > 0 && value['capabilities'] === undefined) fail('missing_required_capability', `${path}.capabilities`)
	for (const capability of [...capabilities].sort()) if (!(value['capabilities'] as unknown[]).includes(capability)) fail('missing_required_capability', `${path}.capabilities`)
	if (value['runtimes'] !== undefined && (!Array.isArray(value['runtimes']) || value['runtimes'].some(item => typeof item !== 'string' || !SKILL_RUNTIMES.includes(item as typeof SKILL_RUNTIMES[number])))) fail('invalid_runtime_binding', `${path}.runtimes`)
	if (Array.isArray(value['runtimes']) && new Set(value['runtimes']).size !== value['runtimes'].length) fail('invalid_runtime_binding', `${path}.runtimes`)
	if (runtimes.length > 0 && value['runtimes'] === undefined) fail('missing_required_capability', `${path}.runtimes`)
	for (const runtime of [...runtimes].sort()) if (!(value['runtimes'] as unknown[]).includes(runtime)) fail('missing_required_capability', `${path}.runtimes`)
	return value as unknown as Sandbox
}

function validateWorkspace(value: unknown): DurableWorkspace {
	if (!isObject(value)) fail('invalid_runtime_binding', 'workspace')
	if (!Array.isArray(value['capabilities'])) fail('invalid_runtime_binding', 'workspace.capabilities')
	if (!(value['capabilities'] as unknown[]).includes('workspace.durable')) fail('missing_required_capability', 'workspace.capabilities')
	if (isObject(value['info']) && Array.isArray(value['info']['capabilities']) && !(value['info']['capabilities'] as unknown[]).includes('workspace.durable')) fail('missing_required_capability', 'workspace.info.capabilities')
	wrapInvalid(() => validateDurableWorkspace(value as unknown as DurableWorkspace), 'workspace')
	return value as unknown as DurableWorkspace
}

function validateArtifactStore(value: unknown): ArtifactStore {
	if (!isObject(value) || typeof value['publish'] !== 'function') fail('invalid_runtime_binding', 'artifacts.publish')
	return value as unknown as ArtifactStore
}

function validateAdmission(value: unknown, path: string): unknown {
	if (!isObject(value) || typeof value['acquire'] !== 'function') fail('invalid_runtime_binding', `${path}.acquire`)
	return value
}

function validateLogger(value: unknown): Logger {
	if (!isObject(value)) fail('invalid_runtime_binding', 'logger')
	for (const method of ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'child'] as const) if (typeof value[method] !== 'function') fail('invalid_runtime_binding', `logger.${method}`)
	return value as unknown as Logger
}

function validateTelemetry(value: unknown): Readonly<TelemetryOptions> {
	if (!isPlainRecord(value)) fail('invalid_runtime_binding', 'telemetry')
	unknownKey(value, ['contentCaptureMode', 'flavor'], 'telemetry')
	if (value['flavor'] !== undefined && !['dual', 'gen_ai_only', 'openinference_only'].includes(String(value['flavor']))) fail('invalid_runtime_binding', 'telemetry.flavor')
	if (value['contentCaptureMode'] !== undefined && !['NO_CONTENT', 'SPAN_ONLY', 'EVENT_ONLY', 'SPAN_AND_EVENT'].includes(String(value['contentCaptureMode']))) fail('invalid_runtime_binding', 'telemetry.contentCaptureMode')
	return Object.freeze({ ...value }) as Readonly<TelemetryOptions>
}

function stringRecord(value: unknown, path: string): Readonly<Record<string, string>> {
	if (!isPlainRecord(value)) fail('invalid_runtime_binding', path)
	const result: Record<string, string> = {}
	for (const key of Object.keys(value).sort()) {
		if (typeof value[key] !== 'string') fail('invalid_runtime_binding', `${path}.${key}`)
		result[key] = value[key]
	}
	return Object.freeze(result)
}

function unknownKey(value: PlainRecord, allowed: readonly string[], path: string): void {
	const key = Object.keys(value).filter(candidate => !allowed.includes(candidate)).sort()[0]
	if (key !== undefined) fail('unexpected_runtime_binding', path ? `${path}.${key}` : key)
}

function snapshot(value: unknown, path: string, ancestors = new WeakSet<object>()): unknown {
	if (value === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value)) return value
	if (typeof value !== 'object') fail('invalid_runtime_binding', path)
	if (ancestors.has(value)) fail('invalid_runtime_binding', path)
	ancestors.add(value)
	if (Array.isArray(value)) {
		const copy = Object.freeze(value.map((item, index) => snapshot(item, `${path}.${index}`, ancestors)))
		ancestors.delete(value)
		return copy
	}
	if (!isPlainRecord(value)) fail('invalid_runtime_binding', path)
	const copy: Record<string, unknown> = {}
	for (const key of Object.keys(value)) copy[key] = snapshot(value[key], `${path}.${key}`, ancestors)
	ancestors.delete(value)
	return Object.freeze(copy)
}

function isHttpUrl(value: string): boolean {
	try { return ['http:', 'https:'].includes(new URL(value).protocol) } catch { return false }
}
function isObject(value: unknown): value is PlainRecord { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function isPlainRecord(value: unknown): value is PlainRecord {
	if (!isObject(value)) return false
	const prototype = Object.getPrototypeOf(value)
	return prototype === Object.prototype || prototype === null
}
function own(value: PlainRecord, key: string): boolean { return Object.prototype.hasOwnProperty.call(value, key) }
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 }
function validateExactKeys(value: PlainRecord, expected: readonly string[], prefix: string): void {
	const candidates = [
		...expected.filter(key => !own(value, key)).map(key => ({ path: `${prefix}.${key}`, reason: 'missing_runtime_binding' })),
		...Object.keys(value).filter(key => !expected.includes(key)).map(key => ({ path: `${prefix}.${key}`, reason: 'unexpected_runtime_binding' })),
	].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
	if (candidates[0] !== undefined) fail(candidates[0].reason, candidates[0].path)
}
function wrapInvalid(run: () => void, path: string): void {
	try { run() } catch (error) {
		const specific = error instanceof HarnessConfigError && typeof error.meta?.['path'] === 'string'
			? error.meta['path']
			: path
		fail('invalid_runtime_binding', specific)
	}
}
function fail(reason: string, path: string): never {
	throw new HarnessConfigError('Harness instance configuration is invalid.', { reason, path })
}
