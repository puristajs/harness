import { hasHarnessTargetContractIdentity } from '../definitions/identity.js'
import type { AnyHarnessTargetContract } from '../ports/target-dispatcher.js'

/**
 * Returns whether a value is an original agent or workflow target contract
 * created by this installed Harness package instance.
 *
 * This integrator boundary deliberately authenticates object identity. A
 * structurally equal value, including one carrying copied property descriptors,
 * is not a Harness target contract.
 */
export function isHarnessTargetContract(value: unknown): value is AnyHarnessTargetContract {
	return hasHarnessTargetContractIdentity(value)
}
