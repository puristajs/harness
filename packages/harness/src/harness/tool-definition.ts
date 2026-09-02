import { HarnessConfigError } from '../errors/catalog.js'

/** Validates structurally declared native and MCP tool definitions. */
export function validateToolDefinitions(tools: Record<string, unknown>): void {
	for (const [id, value] of Object.entries(tools)) {
		if (!isRecord(value)) invalidTool(id, 'Tool definitions must be objects.')
		const definition = value as Record<string, unknown>
		const kind = definition['kind'] ?? 'ts'
		if (kind === 'ts') {
			requireText(definition, 'description', id)
			requireObject(definition, 'input', id)
			requireObject(definition, 'output', id)
			requireFunction(definition, 'handler', id)
			optionalFunction(definition, 'configureHarnessContext', id)
			continue
		}
		if (kind === 'host') {
			requireText(definition, 'description', id)
			requireObject(definition, 'input', id)
			requireObject(definition, 'output', id)
			if (definition['handler'] !== undefined) invalidTool(id, 'Host tool contracts cannot define a handler.')
			continue
		}
		if (kind === 'mcp_stdio') {
			requireText(definition, 'description', id)
			requireText(definition, 'command', id)
			requireText(definition, 'tool', id)
			optionalFunction(definition, 'inputAdapter', id)
			optionalFunction(definition, 'outputAdapter', id)
			optionalFunction(definition, 'configureHarnessContext', id)
			continue
		}
		if (kind === 'mcp_http') {
			requireText(definition, 'description', id)
			requireText(definition, 'url', id)
			requireText(definition, 'tool', id)
			optionalFunction(definition, 'inputAdapter', id)
			optionalFunction(definition, 'outputAdapter', id)
			optionalFunction(definition, 'configureHarnessContext', id)
			continue
		}
		invalidTool(id, 'Tool kind must be ts, host, mcp_stdio, or mcp_http.')
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requireText(definition: Record<string, unknown>, field: string, id: string): void {
	if (typeof definition[field] !== 'string' || definition[field].trim().length === 0) {
		invalidTool(id, `Tool ${field} must be a non-empty string.`)
	}
}

function requireObject(definition: Record<string, unknown>, field: string, id: string): void {
	if (!isRecord(definition[field])) invalidTool(id, `Tool ${field} must be a schema object.`)
}

function requireFunction(definition: Record<string, unknown>, field: string, id: string): void {
	if (typeof definition[field] !== 'function') invalidTool(id, `Tool ${field} must be a function.`)
}

function optionalFunction(definition: Record<string, unknown>, field: string, id: string): void {
	if (definition[field] !== undefined && typeof definition[field] !== 'function') {
		invalidTool(id, `Tool ${field} must be a function when configured.`)
	}
}

function invalidTool(id: string, message: string): never {
	throw new HarnessConfigError(message, { reason: 'invalid_tool', path: `tools.${id}`, id })
}
