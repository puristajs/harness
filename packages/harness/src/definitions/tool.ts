import { HarnessConfigError } from '../errors/index.js'
import type { JsonSchemaBoundary, ModelSchema, Schema } from '../schema/index.js'
import type { MemoryCapability } from '../ports/memory/types.js'
import {
	assertDefinitionId,
	assertKnownFields,
	assertModelSchema,
	assertNonemptyText,
	assertSchema,
	createDefinitionIdentity,
	freezeDefinition,
} from './identity.js'
import type { SandboxCapabilityId, ToolDefinition, ToolOptions, ToolRequirements } from './types.js'

type EmptyRequirements = Readonly<Record<never, never>>

const memoryCapabilities: readonly MemoryCapability[] = Object.freeze([
	'memory.kv', 'memory.list', 'memory.delete', 'memory.ttl', 'memory.text_search',
	'memory.vector_search', 'memory.hybrid_search', 'memory.persistent', 'memory.multi_instance',
])
const sandboxCapabilities: readonly SandboxCapabilityId[] = Object.freeze([
	'sandbox.fs', 'sandbox.text_search', 'sandbox.exec', 'sandbox.readonly_mount', 'sandbox.persistent_fs', 'sandbox.workspace_binding',
	'sandbox.snapshot', 'sandbox.resume', 'sandbox.hibernate', 'sandbox.spawn', 'sandbox.live_process_preservation',
])

/**
 * Defines one portable native TypeScript tool with schema-derived handler types.
 *
 * The returned value is immutable and contains no provider or runtime binding.
 * Memory and sandbox handles appear in the handler context only when declared
 * by `requires`.
 *
 * @example
 * ```ts
 * const lookup = defineTool('lookup', {
 *   description: 'Look up one record.',
 *   input: z.object({ id: z.string() }),
 *   output: z.object({ title: z.string() }),
 *   async handler(context, input) {
 *     return fetchRecord(input.id, context.signal)
 *   },
 * })
 * ```
 */
export function defineTool<
	const Id extends string,
	Input extends ModelSchema,
	Output extends Schema,
	const Requires extends ToolRequirements = EmptyRequirements,
>(id: Id, options: ToolOptions<Input, Output, Requires> & Readonly<{
	input: JsonSchemaBoundary<Input>
	output: JsonSchemaBoundary<Output>
}>): ToolDefinition<Id, Input, Output, Requires> {
	assertDefinitionId(id, 'tool.id')
	assertKnownFields(options, ['description', 'input', 'output', 'requires', 'handler'], 'tool', id)
	assertNonemptyText(options.description, 'tool.description', id)
	assertModelSchema(options.input, 'tool.input', id)
	assertSchema(options.output, 'tool.output', id)
	if (typeof options.handler !== 'function') {
		throwInvalidHandler(id)
	}

	const requires = copyRequirements(options.requires, id)
	const value = {
		kind: 'tool' as const,
		id,
		description: options.description,
		input: options.input,
		output: options.output,
		...(requires === undefined ? {} : { requires }),
		handler: options.handler,
	}
	return freezeDefinition(value, createDefinitionIdentity('tool', id)) as unknown as ToolDefinition<Id, Input, Output, Requires>
}

function copyRequirements<R extends ToolRequirements>(requires: R | undefined, id: string): R | undefined {
	if (requires === undefined) return undefined
	if (typeof requires !== 'object' || requires === null || Array.isArray(requires)) {
		throw new HarnessConfigError('Tool requirements must be an object.', {
			reason: 'invalid_tool_requirement', path: 'tool.requires', id,
		})
	}
	assertKnownFields(requires, ['memory', 'sandbox'], 'tool.requires', id)
	assertCapabilityArray(requires.memory, memoryCapabilities, 'tool.requires.memory', id)
	assertCapabilityArray(requires.sandbox, sandboxCapabilities, 'tool.requires.sandbox', id)
	return Object.freeze({
		...(requires.memory === undefined ? {} : { memory: Object.freeze([...requires.memory]) }),
		...(requires.sandbox === undefined ? {} : { sandbox: Object.freeze([...requires.sandbox]) }),
	}) as R
}

function assertCapabilityArray(
	value: unknown,
	allowed: readonly string[],
	path: string,
	id: string,
): void {
	if (value === undefined) return
	if (!Array.isArray(value) || value.some(capability => typeof capability !== 'string' || !allowed.includes(capability))) {
		throw new HarnessConfigError('Tool requirements must contain only supported capability ids.', {
			reason: 'invalid_tool_requirement', path, id,
		})
	}
}

function throwInvalidHandler(id: string): never {
	throw new HarnessConfigError('Tool handler must be a function.', {
		reason: 'invalid_tool_handler', path: 'tool.handler', id,
	})
}
