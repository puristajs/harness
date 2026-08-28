import { HarnessConfigError } from '../errors/catalog.js'

/** Internal construction marker; never exported from the package public API. */
export const registeredToolDefinition = Symbol('purista.harness.registered-tool-definition')

export function brandToolDefinition<T extends object>(definition: T): T {
  return Object.defineProperty({ ...definition }, registeredToolDefinition, {
    value: true,
    enumerable: true,
    writable: false,
    configurable: false
  })
}

export function validateToolDefinitions(tools: Record<string, unknown>): void {
  for (const [id, definition] of Object.entries(tools)) {
    if (isTsToolDefinitionCandidate(definition) && definition[registeredToolDefinition] !== true) {
      throw new HarnessConfigError('Native tools must be created with the builder-local tool helper.', {
        reason: 'invalid_tool',
        path: `tools.${id}`,
        id
      })
    }
  }
}

function isTsToolDefinitionCandidate(value: unknown): value is Record<PropertyKey, unknown> {
  if (value === null || typeof value !== 'object') return false
  const definition = value as Record<PropertyKey, unknown>
  return typeof definition['handler'] === 'function'
    && 'input' in definition
    && 'output' in definition
    && (definition['kind'] === undefined || definition['kind'] === 'ts')
}
