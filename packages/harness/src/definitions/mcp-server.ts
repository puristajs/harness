import { HarnessConfigError } from '../errors/index.js'
import type { ModelSchema, Schema } from '../schema/index.js'
import {
	assertDefinitionId,
	assertKnownFields,
	assertModelSchema,
	assertNonemptyText,
	assertSchema,
	attachDefinitionIdentity,
	attachDefinitionInference,
	createDefinitionIdentity,
	freezeDefinition,
} from './identity.js'
import type { McpServerDefinition, McpToolDefinition, McpToolOptions } from './types.js'

type McpToolOptionsRecord = Readonly<Record<string, McpToolOptions<ModelSchema, Schema>>>

type McpServerFromOptions<ServerId extends string, Tools extends McpToolOptionsRecord> = McpServerDefinition<
	ServerId,
	McpToolsFromOptions<ServerId, Tools>
>
type McpToolsFromOptions<ServerId extends string, Tools extends McpToolOptionsRecord> = {
	readonly [K in keyof Tools]: Tools[K] extends McpToolOptions<infer Input, infer Output>
		? McpToolDefinition<K & string, Input, Output, McpServerFromOptions<ServerId, Tools>>
		: never
}

/** Explicit local tool surface selected from one MCP server. */
export interface McpServerOptions<Tools extends McpToolOptionsRecord> {
	readonly tools: Tools
}

/**
 * Defines a transport-free MCP server contract with an explicit typed tool map.
 *
 * Supply HTTP or stdio details only when instantiating the completed Harness.
 * The local object keys are the model-facing tool ids; `remoteName` identifies
 * the upstream MCP tool.
 *
 * @example
 * ```ts
 * const knowledge = defineMcpServer('knowledge', {
 *   tools: {
 *     searchKnowledge: {
 *       remoteName: 'search_knowledge',
 *       description: 'Search approved knowledge.',
 *       input: searchInput,
 *       output: searchOutput,
 *     },
 *   },
 * })
 * ```
 */
export function defineMcpServer<const Id extends string, const Tools extends McpToolOptionsRecord>(
	id: Id,
	options: McpServerOptions<Tools>,
): McpServerDefinition<Id, McpToolsFromOptions<Id, Tools>> {
	assertDefinitionId(id, 'mcpServer.id')
	assertKnownFields(options, ['tools'], 'mcpServer', id)
	if (typeof options.tools !== 'object' || options.tools === null || Array.isArray(options.tools)) {
		throwInvalidTools(id)
	}

	const toolValues: Record<string, McpToolDefinition> = {}
	const serverValue = { kind: 'mcp-server' as const, id, tools: toolValues }
	const serverIdentity = createDefinitionIdentity('mcp-server', id)
	attachDefinitionIdentity(serverValue, serverIdentity)

	for (const [localId, tool] of Object.entries(options.tools)) {
		assertDefinitionId(localId, `mcpServer.${id}.tools`)
		assertKnownFields(tool, ['remoteName', 'description', 'input', 'output'], `mcpServer.${id}.tools.${localId}`, localId)
		assertNonemptyText(tool.remoteName, `mcpServer.${id}.tools.${localId}.remoteName`, localId)
		assertNonemptyText(tool.description, `mcpServer.${id}.tools.${localId}.description`, localId)
		assertModelSchema(tool.input, `mcpServer.${id}.tools.${localId}.input`, localId)
		assertSchema(tool.output, `mcpServer.${id}.tools.${localId}.output`, localId)

		const toolValue = {
			kind: 'tool' as const,
			id: localId,
			remoteName: tool.remoteName,
			description: tool.description,
			input: tool.input,
			output: tool.output,
		}
		attachDefinitionInference(toolValue)
		toolValues[localId] = freezeDefinition(
			toolValue,
			createDefinitionIdentity('mcp-tool', localId, serverValue),
		) as McpToolDefinition
	}

	Object.freeze(toolValues)
	attachDefinitionInference(serverValue)
	return Object.freeze(serverValue) as McpServerDefinition<Id, McpToolsFromOptions<Id, Tools>>
}

function throwInvalidTools(id: string): never {
	throw new HarnessConfigError('MCP tools must be an object map.', {
		reason: 'invalid_mcp_tools', path: 'mcpServer.tools', id,
	})
}
