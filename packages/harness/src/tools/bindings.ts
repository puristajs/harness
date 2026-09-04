import type { ModelSchema, Schema } from '../schema/index.js'
import type { Infer } from '../schema/index.js'
import type {
	BuiltInToolDefinition,
	HostToolDefinition,
	McpToolDefinition,
	ToolDefinition,
	ToolHandlerContext,
	ToolRequirements,
} from '../definitions/types.js'
import { getDefinitionIdentity } from '../definitions/identity.js'

/** @internal Prepared implementation owned by one exact definition identity. */
export interface ExecutableToolBinding<
	Input extends ModelSchema = ModelSchema,
	Output extends Schema = Schema,
	Context = never,
> {
	readonly id: string
	readonly description: string
	readonly input: Input
	readonly output: Output
	readonly implementationKind: 'portable' | 'built-in' | 'read-skill' | 'mcp' | 'host'
	readonly definition: object
	invokeValidated(context: Context, input: Infer<Input>): Promise<unknown>
}

function freezeBinding<Input extends ModelSchema, Output extends Schema, Context>(
	binding: ExecutableToolBinding<Input, Output, Context>,
): ExecutableToolBinding<Input, Output, Context> {
	if (getDefinitionIdentity(binding.definition) === undefined) {
		throw new TypeError('Executable tool binding requires a package-owned definition.')
	}
	return Object.freeze(binding)
}

/** @internal Prepares one portable handler without applying policy or validation. */
export function bindPortableTool<
	Id extends string,
	Input extends ModelSchema,
	Output extends Schema,
	Requirements extends ToolRequirements,
>(definition: ToolDefinition<Id, Input, Output, Requirements>): ExecutableToolBinding<
	Input,
	Output,
	ToolHandlerContext<Requirements>
> {
	return freezeBinding({
		id: definition.id,
		description: definition.description,
		input: definition.input,
		output: definition.output,
		implementationKind: 'portable',
		definition,
		invokeValidated: async (context, input) => definition.handler(context, input),
	})
}

/** @internal Prepares a built-in implementation supplied by the runtime. */
export function bindBuiltInTool<Input extends ModelSchema, Output extends Schema, Context>(
	definition: BuiltInToolDefinition<string, Input, Output>,
	invoke: (context: Context, input: Infer<Input>) => Promise<unknown>,
): ExecutableToolBinding<Input, Output, Context> {
	return freezeBinding({
		id: definition.id, description: definition.description, input: definition.input, output: definition.output,
		implementationKind: 'built-in', definition, invokeValidated: invoke,
	})
}

/** @internal Prepares a reserved Skill reader implementation. */
export function bindReadSkillTool<Input extends ModelSchema, Output extends Schema>(
	definition: BuiltInToolDefinition<'read_skill', Input, Output>,
	invoke: (input: Infer<Input>) => Promise<unknown>,
): ExecutableToolBinding<Input, Output, undefined> {
	return freezeBinding({
		id: definition.id, description: definition.description, input: definition.input, output: definition.output,
		implementationKind: 'read-skill', definition, invokeValidated: async (_context, input) => invoke(input),
	})
}

/** @internal Prepares one selected MCP tool against its owning server bundle. */
export function bindMcpTool<Input extends ModelSchema, Output extends Schema>(
	definition: McpToolDefinition<string, Input, Output>,
	invoke: (context: Readonly<{ signal?: AbortSignal }>, remoteName: string, input: Infer<Input>) => Promise<unknown>,
): ExecutableToolBinding<Input, Output, Readonly<{ signal?: AbortSignal }>> {
	return freezeBinding({
		id: definition.id, description: definition.description, input: definition.input, output: definition.output,
		implementationKind: 'mcp', definition,
		invokeValidated: async (context, input) => invoke(context, definition.remoteName, input),
	})
}

/** @internal Reserves host-aware definitions without making them callable standalone. */
export function bindHostToolSeam(definition: HostToolDefinition): Omit<ExecutableToolBinding, 'invokeValidated'> {
	return Object.freeze({
		id: definition.id, description: definition.description, input: definition.input, output: definition.output,
		implementationKind: 'host' as const, definition,
	})
}
