import type { Sandbox } from '@purista/harness'
import { DockerSandbox, CAPABILITIES } from './lifecycle.js'
import type { DockerSandboxOptions } from './options.js'
import { dockerTransport } from './transport.js'

export type { DockerSandboxOptions, DockerSandboxResources } from './options.js'

/**
 * Creates an independent local Docker Sandbox using private named volumes.
 *
 * Configuration belongs at the composition root. Images must already exist in
 * the selected local engine. A retained volume is not a durable-workspace
 * checkpoint; restore fails explicitly until a compatible binding is available.
 *
 * @example
 * ```ts
 * const sandbox = dockerSandbox({ root: '/var/lib/app/sandboxes', image: pinnedImage })
 * const harness = defineHarness().sandbox(sandbox).build()
 * ```
 */
export function dockerSandbox(options: DockerSandboxOptions): Sandbox<typeof CAPABILITIES> {
  return new DockerSandbox(options, dockerTransport)
}
