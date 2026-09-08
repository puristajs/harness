import { HarnessConfigError } from '../errors/index.js'
import type { JsonSchemaBoundary, ModelSchema, Schema } from '../schema/index.js'
import type { Infer, InferIn } from '../schema/index.js'
import {
	assertDefinitionId, assertKnownFields, assertModelSchema, assertNonemptyText, assertSchema,
	attachDefinitionInference, createDefinitionIdentity, freezeDefinition, getDefinitionIdentity,
} from '../definitions/identity.js'
import type { HostToolDefinition } from '../definitions/types.js'

declare const hostOwnerBrand: unique symbol
/** Opaque capability proving that host-aware tools and their runtime bindings share one context owner. */
export type HostOwnerToken<HostContext = unknown> = Readonly<{
	readonly [hostOwnerBrand]: (context: HostContext) => HostContext
}>

const runtimeHostOwnerBrand = Symbol('@purista/harness/host-owner')

/** Creates one immutable owner token for a host integration and its host-aware tools. */
export function createHostOwnerToken<HostContext>(): HostOwnerToken<HostContext> {
	const value = {}
	Object.defineProperty(value, runtimeHostOwnerBrand, { value: true, enumerable: false, configurable: false, writable: false })
	return Object.freeze(value) as HostOwnerToken<HostContext>
}

/** Definition-time contract for a host-aware tool implemented with host-owned context. */
export interface HostToolOptions<Input extends ModelSchema, Output extends Schema, HostContext> {
	readonly description: string
	readonly input: Input
	readonly output: Output
	readonly handler: (context: HostContext, input: Infer<Input>) => Promise<InferIn<Output>>
}

/**
 * Defines a typed tool whose implementation receives context created by a hosting framework.
 *
 * @example
 * ```ts
 * const owner = createHostOwnerToken<MyContext>()
 * const lookup = defineHostTool(owner, 'lookup', { description: 'Look up a record.', input, output,
 *   handler: (context, value) => context.records.find(value.id) })
 * ```
 */
export function defineHostTool<
	const Id extends string,
	Input extends ModelSchema,
	Output extends Schema,
	HostContext,
>(owner: HostOwnerToken<HostContext>, id: Id, options: HostToolOptions<Input, Output, HostContext> & Readonly<{
	input: JsonSchemaBoundary<Input>
	output: JsonSchemaBoundary<Output>
}>): HostToolDefinition<Id, Input, Output, HostContext> {
	if (!isHostOwnerToken(owner)) throw new HarnessConfigError('Host owner token is invalid.', { reason: 'invalid_host_binding', path: 'hostOwner' })
	assertDefinitionId(id, 'hostTool.id')
	assertKnownFields(options, ['description', 'input', 'output', 'handler'], 'hostTool', id)
	assertNonemptyText(options.description, 'hostTool.description', id)
	assertModelSchema(options.input, 'hostTool.input', id)
	assertSchema(options.output, 'hostTool.output', id)
	if (typeof options.handler !== 'function') throw new HarnessConfigError('Host tool handler must be a function.', {
		reason: 'invalid_tool_handler', path: 'hostTool.handler', id,
	})
	const value = { kind: 'tool' as const, id, description: options.description, input: options.input,
		output: options.output, handler: options.handler }
	attachDefinitionInference(value)
	return freezeDefinition(value, createDefinitionIdentity('host-tool', id, owner)) as unknown as HostToolDefinition<Id, Input, Output, HostContext>
}

/** @internal */
export function isHostOwnerToken(value: unknown): value is HostOwnerToken<unknown> {
	return typeof value === 'object' && value !== null && Object.isFrozen(value)
		&& Object.prototype.hasOwnProperty.call(value, runtimeHostOwnerBrand)
}

/** @internal */
export function hostToolOwner(value: unknown): HostOwnerToken<unknown> | undefined {
	const identity = getDefinitionIdentity(value)
	return identity?.kind === 'host-tool' && isHostOwnerToken(identity.owner) ? identity.owner : undefined
}
