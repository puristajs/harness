import { HarnessConfigError } from '../errors/index.js'

type DefinitionIdentityKind = 'tool' | 'mcp-tool' | 'skill' | 'mcp-server' | 'agent' | 'workflow'

/** @internal Compile-time reference brand shared by all definition values. */
export declare const definitionReference: unique symbol

/** @internal Nominal type carried by definition references without adding a public field. */
export type DefinitionReference<Kind extends DefinitionIdentityKind, Id extends string> = {
	readonly [definitionReference]: Readonly<{ kind: Kind; id: Id }>
}

/** @internal Library-owned identity record used by graph compilation. */
export interface DefinitionIdentity {
	readonly kind: DefinitionIdentityKind
	readonly id: string
	/** Exact owning server definition for an MCP tool; absent for root definitions. */
	readonly owner?: object
	readonly token: object
}

const runtimeDefinitionIdentity = Symbol('@purista/harness/definition-identity')

/** @internal Creates a unique immutable identity for one definition value. */
export function createDefinitionIdentity(
	kind: DefinitionIdentityKind,
	id: string,
	owner?: object,
): DefinitionIdentity {
	return Object.freeze({ kind, id, ...(owner === undefined ? {} : { owner }), token: Object.freeze({}) })
}

/** @internal Associates an identity with a value without exposing representation details. */
export function attachDefinitionIdentity<T extends object>(value: T, identity: DefinitionIdentity): T {
	Object.defineProperty(value, runtimeDefinitionIdentity, {
		value: identity,
		enumerable: false,
		configurable: false,
		writable: false,
	})
	return value
}

/** @internal Returns the identity known by this package instance. */
export function getDefinitionIdentity(value: unknown): DefinitionIdentity | undefined {
	return typeof value === 'object' && value !== null
		? (value as { readonly [runtimeDefinitionIdentity]?: DefinitionIdentity })[runtimeDefinitionIdentity]
		: undefined
}

/** @internal Returns whether a value was created by this package instance. */
export function hasDefinitionIdentity(value: unknown): boolean {
	return getDefinitionIdentity(value) !== undefined
}

/** @internal Compares definition identity by its unique token. */
export function sameDefinitionIdentity(left: unknown, right: unknown): boolean {
	const leftIdentity = getDefinitionIdentity(left)
	const rightIdentity = getDefinitionIdentity(right)
	return leftIdentity !== undefined && rightIdentity !== undefined && leftIdentity.token === rightIdentity.token
}

/** @internal Freezes a library-owned value after associating its identity. */
export function freezeDefinition<T extends object>(value: T, identity: DefinitionIdentity): Readonly<T> {
	attachDefinitionIdentity(value, identity)
	return Object.freeze(value)
}

const lowerCamelIdPattern = /^[a-z][A-Za-z0-9]{0,63}$/
const skillIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** @internal Validates a lower-camel definition id. */
export function assertDefinitionId(id: string, path: string): void {
	if (typeof id !== 'string' || !lowerCamelIdPattern.test(id)) {
		throw new HarnessConfigError('Definition id must be lower camel case and contain at most 64 ASCII letters or digits.', {
			reason: 'invalid_definition_id', path, id,
		})
	}
}

/** @internal Validates the external Agent Skills id grammar. */
export function assertSkillId(id: string): void {
	if (typeof id !== 'string' || id.length > 64 || !skillIdPattern.test(id)) {
		throw new HarnessConfigError('Skill id must be 1-64 lowercase ASCII letters, numbers, or hyphens with no leading, trailing, or consecutive hyphens.', {
			reason: 'invalid_skill_id', path: 'skill.id', id,
		})
	}
}

/** @internal Validates required definition text without retaining content in error metadata. */
export function assertNonemptyText(value: unknown, path: string, id: string): asserts value is string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new HarnessConfigError('Definition text fields must be non-empty strings.', {
			reason: 'invalid_definition_text', path, id,
		})
	}
}

/** @internal Rejects undeclared authoring fields for JavaScript callers. */
export function assertKnownFields(value: object, fields: readonly string[], path: string, id: string): void {
	const allowed = new Set(fields)
	const unknown = Object.keys(value).find(key => !allowed.has(key))
	if (unknown !== undefined) {
		throw new HarnessConfigError('Definition contains an unsupported field.', {
			reason: 'unknown_definition_field', path: `${path}.${unknown}`, id,
		})
	}
}

/** @internal Validates a Standard Schema boundary. */
export function assertSchema(value: unknown, path: string, id: string): void {
	const standard = typeof value === 'object' && value !== null
		? (value as { '~standard'?: { validate?: unknown } })['~standard']
		: undefined
	if (typeof standard?.validate !== 'function') {
		throw new HarnessConfigError('Definition schema must implement Standard Schema.', {
			reason: 'invalid_definition_schema', path, id,
		})
	}
}

/** @internal Validates a Standard JSON Schema model boundary. */
export function assertModelSchema(value: unknown, path: string, id: string): void {
	assertSchema(value, path, id)
	const jsonSchema = (value as { '~standard': { jsonSchema?: { input?: unknown; output?: unknown } } })['~standard'].jsonSchema
	if (typeof jsonSchema?.input !== 'function' || typeof jsonSchema.output !== 'function') {
		throw new HarnessConfigError('Model-facing schema must implement Standard JSON Schema.', {
			reason: 'invalid_model_schema', path, id,
		})
	}
}

/** @internal Validates a positive integer definition limit. */
export function assertPositiveInteger(value: unknown, path: string, id: string): void {
	if (!Number.isInteger(value) || (value as number) < 1) {
		throw new HarnessConfigError('Definition limits must be positive integers.', {
			reason: 'invalid_definition_limit', path, id,
		})
	}
}
