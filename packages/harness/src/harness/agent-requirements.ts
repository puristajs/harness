import { z } from 'zod'
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
  'rerank'
])

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

const nonEmptyUniqueIdsSchema = z.array(z.string().min(1)).min(1).superRefine((values, ctx) => {
  uniqueStrings(values, ctx, [])
})

const requiredModelSchema = z.object({
  alias: z.string().min(1),
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
  }).optional()
}).strict()

/** Requirements derived from {@link agentExecutionRequirementsSchema}. */
export type AgentExecutionRequirements = z.output<typeof agentExecutionRequirementsSchema>

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
