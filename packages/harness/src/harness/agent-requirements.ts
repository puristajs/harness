import { z } from 'zod'
import type { SandboxCapabilityId, SkillRuntimeId } from '../definitions/types.js'
import type { MemoryCapability } from '../ports/memory/types.js'
import type { ModelCapability } from '../ports/model-provider.js'

const modelCapabilitySchema = z.enum([
  'text',
  'text_stream',
  'object',
  'object_stream',
  'tool_use',
  'vision_input',
  'audio_input',
  'file_input',
  'embeddings',
  'rerank',
  'image_generation',
  'speech_generation',
  'video_generation'
])
const memoryCapabilitySchema = z.enum([
  'memory.kv', 'memory.list', 'memory.delete', 'memory.ttl', 'memory.text_search',
  'memory.vector_search', 'memory.hybrid_search', 'memory.persistent', 'memory.multi_instance'
])
const sandboxCapabilitySchema = z.enum([
  'sandbox.fs', 'sandbox.text_search', 'sandbox.exec', 'sandbox.readonly_mount', 'sandbox.persistent_fs',
  'sandbox.workspace_binding', 'sandbox.snapshot', 'sandbox.resume', 'sandbox.hibernate',
  'sandbox.spawn', 'sandbox.live_process_preservation'
])
const skillRuntimeSchema = z.enum(['node', 'python', 'shell'])
const lowerCamelAliasSchema = z.string().regex(/^[a-z][A-Za-z0-9]{0,63}$/)

function uniqueStrings(values: readonly string[], ctx: z.RefinementCtx, path: readonly (string | number)[]): void {
  const seen = new Set<string>()
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      ctx.addIssue({ code: 'custom', message: 'Values must be unique.', path: [...path, index] })
      continue
    }
    seen.add(value)
  }
}

const nonEmptyUniqueIdsSchema = z.array(lowerCamelAliasSchema).min(1).superRefine((values, ctx) => {
  uniqueStrings(values, ctx, [])
})

const requiredModelSchema = z.object({
  alias: lowerCamelAliasSchema,
  capabilities: z.array(modelCapabilitySchema).min(1).superRefine((values, ctx) => {
    uniqueStrings(values, ctx, [])
  })
}).strict()

/**
 * Declarative model and tool dependencies required by an agent interceptor.
 *
 * The Harness validates these declarations during `.build()` only. They never
 * grant tool access, add models, or cause provider, sandbox, or MCP work.
 */
export const agentExecutionRequirementsSchema = z.object({
  tools: nonEmptyUniqueIdsSchema.optional(),
  models: z.array(requiredModelSchema).min(1).superRefine((models, ctx) => {
    uniqueStrings(models.map((model) => model.alias), ctx, [])
  }).optional(),
  memory: z.array(memoryCapabilitySchema).min(1).superRefine((values, ctx) => uniqueStrings(values, ctx, [])).optional(),
  sandbox: z.array(sandboxCapabilitySchema).min(1).superRefine((values, ctx) => uniqueStrings(values, ctx, [])).optional(),
  skillRuntimes: z.array(skillRuntimeSchema).min(1).superRefine((values, ctx) => uniqueStrings(values, ctx, [])).optional(),
  durable: z.literal(true).optional(),
  workspace: z.literal(true).optional(),
  artifacts: z.literal(true).optional()
}).strict()

/** Exact declarative runtime dependencies of an agent execution interceptor. */
export interface AgentExecutionRequirements<
  Tools extends readonly string[] = readonly string[],
  Models extends readonly Readonly<{ alias: string; capabilities: readonly ModelCapability[] }>[] = readonly Readonly<{ alias: string; capabilities: readonly ModelCapability[] }>[],
  Memory extends readonly MemoryCapability[] = readonly MemoryCapability[],
  Sandbox extends readonly SandboxCapabilityId[] = readonly SandboxCapabilityId[],
  SkillRuntimes extends readonly SkillRuntimeId[] = readonly SkillRuntimeId[],
  Durable extends true | undefined = true | undefined,
  Workspace extends true | undefined = true | undefined,
  Artifacts extends true | undefined = true | undefined,
> {
  readonly tools?: Tools | undefined
  readonly models?: Models | undefined
  readonly memory?: Memory | undefined
  readonly sandbox?: Sandbox | undefined
  readonly skillRuntimes?: SkillRuntimes | undefined
  readonly durable?: Durable | undefined
  readonly workspace?: Workspace | undefined
  readonly artifacts?: Artifacts | undefined
}

/** Validated requirements together with their owning interceptor declaration. */
export type AgentExecutionRequirementDeclaration = Readonly<{
  path: string
  requirements: AgentExecutionRequirements
}>

/** Internal requirement shape after deterministic interceptor-order merging. */
export type CompiledAgentExecutionRequirements = Readonly<{
  tools: readonly Readonly<{ id: string; path: string }>[],
  models: readonly Readonly<{
    alias: string
    path: string
    capabilities: readonly Readonly<{ capability: ModelCapability; path: string }>[],
  }>[]
}>

/**
 * Merges already validated interceptor requirements without weakening earlier
 * declarations. Tool ids and capabilities retain their first declaration order.
 */
export function compileAgentExecutionRequirements(
  declarations: readonly AgentExecutionRequirementDeclaration[]
): CompiledAgentExecutionRequirements {
  const tools: Array<{ id: string; path: string }> = []
  const toolIds = new Set<string>()
  const models = new Map<string, { path: string; capabilities: Array<{ capability: ModelCapability; path: string }> }>()

  for (const { path, requirements } of declarations) {
    for (const id of requirements.tools ?? []) {
      if (!toolIds.has(id)) {
        toolIds.add(id)
        tools.push({ id, path })
      }
    }
    for (const model of requirements.models ?? []) {
      const compiled = models.get(model.alias) ?? { path, capabilities: [] }
      if (!models.has(model.alias)) models.set(model.alias, compiled)
      for (const capability of model.capabilities) {
        if (!compiled.capabilities.some((entry) => entry.capability === capability)) {
          compiled.capabilities.push({ capability, path })
        }
      }
    }
  }

  return Object.freeze({
    tools: Object.freeze(tools),
    models: Object.freeze([...models].map(([alias, model]) => Object.freeze({
      alias,
      path: model.path,
      capabilities: Object.freeze(model.capabilities.map((capability) => Object.freeze(capability)))
    })))
  })
}
