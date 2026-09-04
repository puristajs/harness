import type { RuntimeRequirements } from '../src/runtime/runtime-requirements.js'
import type {
	HarnessInstanceConfig,
	McpBinding,
	ModelRuntimeBinding,
} from '../src/runtime/instance-config.js'
import type { ModelProvider } from '../src/ports/model-provider.js'
import type { ModelCapability } from '../src/ports/model-provider.js'
import type { MemoryCapability } from '../src/ports/memory/types.js'
import type { SandboxCapabilityId } from '../src/definitions/types.js'
import type { Sandbox, SpawnCapableSandbox } from '../src/sandbox/index.js'

type EmptyModels = Readonly<Record<never, never>>
type Requirements<
	Models extends Readonly<Record<string, Readonly<{ capabilities: readonly ModelCapability[] }>>> = EmptyModels,
	Mcp extends string = never,
	Runtime extends 'node' | 'python' | 'shell' = never,
	Memory extends MemoryCapability = never,
	SandboxCapability extends SandboxCapabilityId = never,
	HostTool extends string = never,
	Durable extends boolean = false,
	Workspace extends boolean = false,
	Artifacts extends boolean = false,
> = RuntimeRequirements<Models, Mcp, Runtime, Memory, never, SandboxCapability, HostTool, Durable, Workspace, Artifacts>

declare const provider: ModelProvider
declare const sandbox: Sandbox<readonly ['sandbox.fs', 'sandbox.spawn']> & {
	readonly capabilities: readonly ['sandbox.fs', 'sandbox.spawn']
	readonly runtimes: readonly ['python']
}
declare const spawnSandbox: SpawnCapableSandbox<readonly ['sandbox.spawn']>
declare const storage: import('../src/storage/types.js').HarnessStorage
declare const memory: import('../src/ports/memory/types.js').MemoryEngine
declare const workspace: import('../src/ports/workspace.js').DurableWorkspace
declare const artifacts: import('../src/ports/artifact-store.js').ArtifactStore

const modelBinding: ModelRuntimeBinding = { provider, model: 'model-id' }
void modelBinding
// @ts-expect-error callers never repeat derived capabilities
const repeatedCapabilities: ModelRuntimeBinding = { provider, model: 'model-id', capabilities: ['text'] }
void repeatedCapabilities

const emptyConfig: HarnessInstanceConfig<Requirements> = {}
void emptyConfig
// @ts-expect-error an empty graph forbids model selectors
const emptyWithModel: HarnessInstanceConfig<Requirements> = { model: modelBinding }
void emptyWithModel

type PrimaryRequirements = Requirements<Readonly<{ primary: Readonly<{ capabilities: readonly ['text', 'text_stream'] }> }>>
const primaryConfig: HarnessInstanceConfig<PrimaryRequirements> = { model: modelBinding }
void primaryConfig
// @ts-expect-error the exact primary-only case requires the concise model field
const primaryMissing: HarnessInstanceConfig<PrimaryRequirements> = {}
void primaryMissing
// @ts-expect-error the exact primary-only case forbids models
const primaryModels: HarnessInstanceConfig<PrimaryRequirements> = { models: { primary: modelBinding } }
void primaryModels

type MultiRequirements = Requirements<Readonly<{
	primary: Readonly<{ capabilities: readonly ['text'] }>
	fast: Readonly<{ capabilities: readonly ['text_stream'] }>
}>>
const multiConfig: HarnessInstanceConfig<MultiRequirements> = {
	models: { primary: modelBinding, fast: modelBinding },
}
void multiConfig
// @ts-expect-error every inferred model alias is required
const multiMissingAlias: HarnessInstanceConfig<MultiRequirements> = { models: { primary: modelBinding } }
void multiMissingAlias
const multiExtraAlias: HarnessInstanceConfig<MultiRequirements> = {
	// @ts-expect-error undeclared model aliases are rejected
	models: { primary: modelBinding, fast: modelBinding, other: modelBinding },
}
void multiExtraAlias
// @ts-expect-error multi-model graphs forbid the concise selector
const multiConcise: HarnessInstanceConfig<MultiRequirements> = { model: modelBinding }
void multiConcise

type AdvancedRequirements = Requirements<
	Readonly<{ primary: Readonly<{ capabilities: readonly ['text'] }> }>,
	'knowledge',
	'python',
	'memory.kv',
	'sandbox.fs',
	never,
	true,
	true,
	true
>
const http: McpBinding = { transport: 'http', url: 'https://example.com/mcp', headers: { authorization: 'secret' } }
const stdio: McpBinding = { transport: 'stdio', command: 'node', args: ['server.js'], sandbox: spawnSandbox }
void http
void stdio
const advancedConfig: HarnessInstanceConfig<AdvancedRequirements> = {
	model: modelBinding,
	mcp: { knowledge: http },
	storage,
	memory,
	sandbox,
	workspace,
	artifacts,
	agentAdmission: { async acquire() { return { release() {} } } },
	admission: { async acquire() { return { release() {} } } },
	logger: {
		trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this },
	},
	telemetry: { flavor: 'dual', contentCaptureMode: 'NO_CONTENT' },
}
void advancedConfig
// @ts-expect-error required infrastructure groups cannot be omitted
const missingAdvanced: HarnessInstanceConfig<AdvancedRequirements> = { model: modelBinding }
void missingAdvanced
// @ts-expect-error unused infrastructure is forbidden
const primaryWithMemory: HarnessInstanceConfig<PrimaryRequirements> = { model: modelBinding, memory }
void primaryWithMemory

type HostRequirements = Requirements<EmptyModels, never, never, never, never, 'invokeCommand'>
// @ts-expect-error host-aware graphs cannot be configured through the standalone entry point
const hostedConfig: HarnessInstanceConfig<HostRequirements> = {}
void hostedConfig

declare const noSpawnSandbox: Sandbox<readonly ['sandbox.fs']>
// @ts-expect-error stdio MCP requires a sandbox that declares sandbox.spawn
const invalidStdio: McpBinding = { transport: 'stdio', command: 'node', sandbox: noSpawnSandbox }
void invalidStdio
declare const broadSandbox: Sandbox
// @ts-expect-error a broad Sandbox does not guarantee that open() returns a spawn-capable session
const invalidBroadStdio: McpBinding = { transport: 'stdio', command: 'node', sandbox: broadSandbox }
void invalidBroadStdio
// @ts-expect-error HTTP MCP has no process command field
const invalidHttpField: McpBinding = { transport: 'http', url: 'https://example.com', command: 'node' }
void invalidHttpField

type RuntimeOnlyRequirements = Requirements<EmptyModels, never, 'python'>
declare const runtimeOnlySandbox: Sandbox & { readonly runtimes: readonly ['python'] }
const runtimeOnlyConfig: HarnessInstanceConfig<RuntimeOnlyRequirements> = { sandbox: runtimeOnlySandbox }
void runtimeOnlyConfig
// @ts-expect-error a Skill runtime requirement makes sandbox.runtimes mandatory
const missingRuntimeMetadata: HarnessInstanceConfig<RuntimeOnlyRequirements> = { sandbox: noSpawnSandbox }
void missingRuntimeMetadata

type SandboxOnlyRequirements = Requirements<EmptyModels, never, never, never, 'sandbox.fs'>
declare const sandboxWithoutCapabilities: Sandbox
// @ts-expect-error a sandbox capability requirement makes sandbox.capabilities mandatory
const missingSandboxCapabilities: HarnessInstanceConfig<SandboxOnlyRequirements> = { sandbox: sandboxWithoutCapabilities }
void missingSandboxCapabilities
