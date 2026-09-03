import { isAbsolute, resolve } from 'node:path'
import { HarnessConfigError, SandboxError, type SandboxAdministrationOptions } from '@purista/harness'
import { z } from 'zod'

const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const resourcesSchema = z.strictObject({
  cpus: z.number().finite().positive().default(1).describe('CPU limit; defaults to one CPU.'),
  memoryMb: positiveInteger.default(512).describe('Memory limit in MiB; defaults to 512.'),
  pids: positiveInteger.default(128).describe('Process limit; defaults to 128.'),
  tmpfsMb: positiveInteger.default(64).describe('Temporary filesystem limit in MiB; defaults to 64.'),
})

const optionsSchema = z.strictObject({
  root: z.string().min(1).refine(isAbsolute).refine(value => !value.includes('\0')).describe('Absolute private metadata directory; never mounted into the guest.'),
  image: z.string().regex(/^(?:[^\s\0]+@)?sha256:[a-f0-9]{64}$/).describe('Already-present image pinned by repository digest or immutable sha256 image ID.'),
  context: z.string().trim().min(1).refine(value => !value.includes('\0')).optional().describe('Local Docker context; defaults to the active context resolved once.'),
  user: z.string().regex(/^[1-9]\d*:[1-9]\d*$/).refine(value => value.split(':').every(part => Number.isSafeInteger(Number(part)) && Number(part) <= 4_294_967_294)).default('1000:1000').describe('Non-root numeric UID:GID; defaults to 1000:1000.'),
  network: z.enum(['none', 'bridge']).default('none').describe('Guest networking; disabled by default.'),
  resources: resourcesSchema.prefault({}),
  administration: z.strictObject({
    maxCatalogEntries: positiveInteger.optional(),
    selectorRevocationReserve: positiveInteger.optional(),
    maxActiveSandboxes: positiveInteger.optional(),
  }).superRefine((value, context) => {
    const entries = value.maxCatalogEntries ?? 10_000
    const reserve = value.selectorRevocationReserve ?? 256
    if (reserve + 2 >= entries) context.addIssue({ code: 'custom', path: ['selectorRevocationReserve'], message: 'The revocation reserve must leave capacity for an owner barrier and purge progress.' })
  }).optional(),
})

/** Closed CPU, memory, process, and temporary-storage overrides. */
export interface DockerSandboxResources extends z.input<typeof resourcesSchema> {
  /** Positive CPU limit; defaults to one CPU. */
  readonly cpus?: number
  /** Positive memory limit in MiB; defaults to 512. */
  readonly memoryMb?: number
  /** Positive process limit; defaults to 128. */
  readonly pids?: number
  /** Positive `/tmp` size in MiB; defaults to 64. */
  readonly tmpfsMb?: number
}
/** Composition-root options. No host mounts or arbitrary Docker flags are accepted. */
export interface DockerSandboxOptions extends z.input<typeof optionsSchema> {
  /** Absolute caller-owned metadata directory. Never mounted into a guest. */
  readonly root: string
  /** Already-present `repository@sha256:...` or local `sha256:...` image ID. */
  readonly image: string
  /** Local Docker context. Omitted selects the active context once, before mutation. */
  readonly context?: string
  /** Numeric non-root UID:GID. Defaults to `1000:1000`. */
  readonly user?: string
  /** Guest networking. Defaults to `none`; bridge access is explicitly trusted. */
  readonly network?: 'none' | 'bridge'
  /** Optional individual resource overrides; omitted limits use secure defaults. */
  readonly resources?: DockerSandboxResources
  /** Bounded private owner/catalog limits. Docker volume byte quotas are not portable. */
  readonly administration?: SandboxAdministrationOptions
}
export type ResolvedOptions = z.output<typeof optionsSchema>

export function resolveOptions(input: DockerSandboxOptions): ResolvedOptions {
  const result = optionsSchema.safeParse(input)
  if (!result.success) throw configurationFailure('invalid_configuration', 'Docker sandbox configuration is invalid. Use an absolute metadata root, digest-pinned image, and positive resource limits.')
  return { ...result.data, root: resolve(result.data.root) }
}

export function failure(reason: string, message = 'Docker sandbox operation failed.'): SandboxError {
  return new SandboxError(message, { reason })
}
export function configurationFailure(reason: string, message: string): HarnessConfigError { return new HarnessConfigError(message, { reason }) }
