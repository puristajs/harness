import { createRequire } from 'node:module'

export interface NativeFinding {
  readonly category: string
  readonly start: number
  readonly end: number
  readonly score: number
}

export interface NativePrivacyBinding {
  inspect(requestId: string, text: string, entities: readonly string[], scoreThreshold: number): Promise<readonly NativeFinding[]>
  cancel(requestId: string): void
}

const require = createRequire(import.meta.url)

/** Loads exactly one Node-API binary for both Node.js and Bun. */
export function loadNativePrivacyBinding(): NativePrivacyBinding {
  const platform = platformPackage()
  const errors: unknown[] = []
  for (const moduleId of [`../harness_guardrails_native_privacy.${platform}.node`, `@purista/harness-guardrails-native-privacy-${platform}`]) {
    try {
      return require(moduleId) as NativePrivacyBinding
    } catch (error) {
      errors.push(error)
    }
  }
  throw new NativePrivacyBindingError('unsupported_platform')
}

/** A safe native-loader failure that contains no platform request data or source text. */
export class NativePrivacyBindingError extends Error {
  public readonly kind: 'unsupported_platform' | 'aborted' | 'native_failure'

  public constructor(kind: 'unsupported_platform' | 'aborted' | 'native_failure') {
    super('Native privacy detector is unavailable.')
    this.name = 'NativePrivacyBindingError'
    this.kind = kind
  }
}

function platformPackage(): string {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin-arm64'
  if (process.platform === 'darwin' && process.arch === 'x64') return 'darwin-x64'
  if (process.platform === 'linux' && process.arch === 'arm64') return 'linux-arm64-gnu'
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux-x64-gnu'
  if (process.platform === 'win32' && process.arch === 'arm64') return 'win32-arm64-msvc'
  if (process.platform === 'win32' && process.arch === 'x64') return 'win32-x64-msvc'
  throw new NativePrivacyBindingError('unsupported_platform')
}
