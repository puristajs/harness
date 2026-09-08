import { HarnessConfigError } from '../errors/index.js'
import {
	assertKnownFields,
	assertSkillId,
	attachDefinitionInference,
	createDefinitionIdentity,
	freezeDefinition,
} from './identity.js'
import type { SkillDefinition, SkillRuntimeId } from './types.js'

const skillRuntimeIds: readonly SkillRuntimeId[] = Object.freeze(['node', 'python', 'shell'])

/** Definition-time location and optional runtime availability requirements for an Agent Skill. */
export interface SkillOptions<Runtimes extends readonly SkillRuntimeId[] | undefined = undefined> {
	readonly directory: URL
	readonly runtimes?: Runtimes
}

/**
 * Defines one Agent Skill directory and its logical runtime requirements.
 *
 * Runtime ids describe availability only. They do not install software or
 * grant filesystem, process, or network access.
 *
 * @example
 * ```ts
 * const analysis = defineSkill('transaction-analysis', {
 *   directory: new URL('./transaction-analysis/', import.meta.url),
 *   runtimes: ['python'],
 * })
 * ```
 */
export function defineSkill<
	const Id extends string,
	const Runtimes extends readonly SkillRuntimeId[] | undefined = undefined,
>(id: Id, options: SkillOptions<Runtimes>): SkillDefinition<Id, ResolvedSkillRuntimes<Runtimes>> & (
	Runtimes extends undefined ? { readonly runtimes?: undefined } : { readonly runtimes: Runtimes }
) {
	assertSkillId(id)
	assertKnownFields(options, ['directory', 'runtimes'], 'skill', id)
	if (!(options.directory instanceof URL)) {
		throw new HarnessConfigError('Skill directory must be a URL.', {
			reason: 'invalid_skill_directory', path: 'skill.directory', id,
		})
	}
	if (options.runtimes !== undefined && (
		!Array.isArray(options.runtimes)
		|| options.runtimes.some(runtime => !skillRuntimeIds.includes(runtime))
	)) {
		throw new HarnessConfigError('Skill runtime must be node, python, or shell.', {
			reason: 'invalid_skill_runtime', path: 'skill.runtimes', id,
		})
	}

	const runtimes = options.runtimes === undefined ? undefined : Object.freeze([...options.runtimes]) as Runtimes
	const directoryHref = options.directory.href
	const value = {
		kind: 'skill' as const,
		id,
		get directory() { return new URL(directoryHref) },
		...(runtimes === undefined ? {} : { runtimes }),
	}
	attachDefinitionInference(value)
	return freezeDefinition(value, createDefinitionIdentity('skill', id)) as ReturnTypeShape<Id, Runtimes>
}

type ResolvedSkillRuntimes<Runtimes extends readonly SkillRuntimeId[] | undefined> =
	Runtimes extends readonly SkillRuntimeId[] ? Runtimes : readonly []

type ReturnTypeShape<Id extends string, Runtimes extends readonly SkillRuntimeId[] | undefined> =
	SkillDefinition<Id, ResolvedSkillRuntimes<Runtimes>> & (
		Runtimes extends undefined ? { readonly runtimes?: undefined } : { readonly runtimes: Runtimes }
	)
