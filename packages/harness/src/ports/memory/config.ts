import type { ModelCapability } from '../model-provider.js'
import type { MemoryCapability, MemoryEngine } from './types.js'

declare const memoryModelReferenceBrand: unique symbol

/** Frozen configuration-time projection of a model alias. It is never a live provider handle. */
export interface MemoryModelReference<Alias extends string = string, Capabilities extends readonly ModelCapability[] = readonly ModelCapability[]> {
  readonly alias: Alias
  readonly capabilities: Capabilities
  readonly [memoryModelReferenceBrand]: never
}

type Includes<Values extends readonly string[], Value extends string> = Value extends Values[number] ? true : false

/** References are properties, so `model.memoryEmbedding` preserves the configured alias spelling. */
export type MemoryModelReferences<Models extends Record<string, { capabilities: readonly ModelCapability[] }>> = {
  readonly [Alias in keyof Models & string]: MemoryModelReference<Alias, Models[Alias]['capabilities']>
}

export type ModelReferenceWithCapability<Models extends Record<string, { capabilities: readonly ModelCapability[] }>, Capability extends ModelCapability> = {
  readonly [Alias in keyof Models & string]: Capability extends Models[Alias]['capabilities'][number]
    ? MemoryModelReference<Alias, Models[Alias]['capabilities']>
    : never
}[keyof Models & string]

export type MemoryEmbeddingConfiguration<Models extends Record<string, { capabilities: readonly ModelCapability[] }>> =
  | ModelReferenceWithCapability<Models, 'embeddings'>
  | { readonly model: ModelReferenceWithCapability<Models, 'embeddings'> }

export type MemorySummaryConfiguration<Models extends Record<string, { capabilities: readonly ModelCapability[] }>> =
  | ModelReferenceWithCapability<Models, 'object'>
  | { readonly model: ModelReferenceWithCapability<Models, 'object'>; readonly everyTurns?: number; readonly sourceTurns?: number }

/** Optional core orchestration layered over a vendor-neutral engine. */
export interface MemoryConfiguration<C extends readonly MemoryCapability[] = readonly MemoryCapability[], Models extends Record<string, { capabilities: readonly ModelCapability[] }> = Record<string, { capabilities: readonly ModelCapability[] }>> {
  readonly engine: MemoryEngine<C>
  /** Requires an engine that advertises `memory.vector_search`. */
  readonly embedding?: Includes<C, 'memory.vector_search'> extends true ? MemoryEmbeddingConfiguration<Models> : never
  /** Generates a bounded conversation summary after successful completed turns. */
  readonly summary?: MemorySummaryConfiguration<Models>
}

export type MemoryConfigurationFor<C extends readonly MemoryCapability[], Models extends Record<string, { capabilities: readonly ModelCapability[] }>> = MemoryConfiguration<C, Models>
