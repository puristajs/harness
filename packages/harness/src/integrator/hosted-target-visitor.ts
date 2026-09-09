import type { HarnessCatalogView, HarnessContracts } from '../definitions/catalog.js'
import {
	getHarnessRuntimeBlueprint,
	type HarnessDefinition,
	type HarnessGraphView,
} from '../definitions/harness.js'
import { HarnessConfigError } from '../errors/index.js'
import type { AnyHarnessTargetContract } from '../ports/target-dispatcher.js'
import { isHarnessTargetContract } from './target-contract.js'

type HostedTargetOf<Contracts extends HarnessContracts<any, any>> =
	| Contracts['agents'][keyof Contracts['agents']]
	| Contracts['workflows'][keyof Contracts['workflows']]

type CompiledTargetOf<Graph extends HarnessGraphView> = HostedTargetOf<
	HarnessContracts<Graph['agents'], Graph['workflows']>
>

/** Frozen minimum projection for one authentic target in a hosted Harness closure. */
export type HostedHarnessTargetEntry<Target extends AnyHarnessTargetContract> = Readonly<{
	target: Target
	visibility: 'root' | 'dependency'
}>

/**
 * Visits every authentic agent and workflow in a compiled Harness closure.
 *
 * The complete closure is authenticated before the first callback. Agents are
 * visited by Unicode code-point id order before workflows, and original root
 * contract identity determines visibility.
 *
 * @example
 * ```ts
 * visitHostedHarnessTargets(definition, ({ target, visibility }) => {
 *   registerTarget(target, visibility)
 * })
 * ```
 */
export function visitHostedHarnessTargets<
	Catalog extends HarnessCatalogView,
	Name extends string,
	Graph extends HarnessGraphView,
>(
	definition: HarnessDefinition<Catalog, Name, Graph>,
	visitor: (entry: HostedHarnessTargetEntry<CompiledTargetOf<Graph>>) => void,
): void {
	const blueprint = getHarnessRuntimeBlueprint(definition)
	if (blueprint === undefined) throw foreignDefinition('definition')

	const rootTargets = new Set<unknown>([
		...Object.values(definition.contracts.agents),
		...Object.values(definition.contracts.workflows),
	])
	const rows: Array<Readonly<{
		target: AnyHarnessTargetContract
		visibility: 'root' | 'dependency'
	}>> = []

	for (const [kind, definitions] of [
		['agents', blueprint.graph.agents],
		['workflows', blueprint.graph.workflows],
	] as const) {
		for (const id of Object.keys(definitions).sort(codePointCompare)) {
			const target = definitions[id]!.contract
			if (!isHarnessTargetContract(target) || target.kind !== (kind === 'agents' ? 'agent' : 'workflow')) {
				throw foreignDefinition(`graph.${kind}.${id}.contract`)
			}
			rows.push(Object.freeze({
				target,
				visibility: rootTargets.has(target) ? 'root' : 'dependency',
			}))
		}
	}

	for (const row of rows) {
		visitor(row as HostedHarnessTargetEntry<CompiledTargetOf<Graph>>)
	}
}

function foreignDefinition(path: string): HarnessConfigError {
	return new HarnessConfigError('Hosted Harness definition is invalid.', {
		reason: 'foreign_definition',
		path,
	})
}

function codePointCompare(left: string, right: string): number {
	const a = Array.from(left, character => character.codePointAt(0)!)
	const b = Array.from(right, character => character.codePointAt(0)!)
	for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
		if (a[index] !== b[index]) return a[index]! - b[index]!
	}
	return a.length - b.length
}
