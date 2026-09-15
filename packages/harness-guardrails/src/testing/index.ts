import type { SensitiveDataDetector, SensitiveDataExecutionMode, SensitiveDataFinding, SensitiveDataInspectionRequest, SensitiveDataInspectionResult } from '../sensitive-data.js'

/** Construction options for the deterministic sensitive-data detector fake. */
export interface FakeSensitiveDataDetectorOptions {
  /** Stable test identity. Defaults to `fake-sensitive-data-detector`. */
  readonly id?: string
  /** Declared test execution boundary. Defaults to `local`. */
  readonly executionMode?: SensitiveDataExecutionMode
  /** Optional detector capability declaration exercised by Guardrails setup validation. */
  readonly supportedEntities?: readonly string[]
}

type ScriptedInspection =
  | { readonly kind: 'result'; readonly result: SensitiveDataInspectionResult }
  | { readonly kind: 'error'; readonly error: Error }

/** A deterministic, content-free sensitive-data detector for application and addon tests. */
export class FakeSensitiveDataDetector implements SensitiveDataDetector {
  public readonly id: string
  public readonly executionMode: SensitiveDataExecutionMode
  public readonly supportedEntities?: readonly string[]
  public readonly requests: SensitiveDataInspectionRequest[] = []
  private readonly responses: ScriptedInspection[] = []

  /**
   * @param options Stable fake identity and optional declared capabilities.
   * @example
   * const detector = new FakeSensitiveDataDetector({ supportedEntities: ['EMAIL_ADDRESS'] })
   */
  public constructor(options: FakeSensitiveDataDetectorOptions = {}) {
    this.id = options.id ?? 'fake-sensitive-data-detector'
    this.executionMode = options.executionMode ?? 'local'
    if (options.supportedEntities) this.supportedEntities = options.supportedEntities
  }

  /** Enqueues findings returned by the next inspection, preserving the concise existing test API. */
  public enqueue(findings: readonly SensitiveDataFinding[]): void {
    this.enqueueResult({ findings })
  }

  /** Enqueues a complete deterministic inspection result for the next inspection. */
  public enqueueResult(result: SensitiveDataInspectionResult): void {
    this.responses.push({ kind: 'result', result })
  }

  /** Enqueues an intentional detector failure for the next inspection. */
  public enqueueError(error: Error = new Error('Fake sensitive-data detector failure.')): void {
    this.responses.push({ kind: 'error', error })
  }

  /** Clears recorded requests and scripted outcomes between application test cases. */
  public reset(): void {
    this.requests.length = 0
    this.responses.length = 0
  }

  public async inspect(request: SensitiveDataInspectionRequest): Promise<SensitiveDataInspectionResult> {
    this.requests.push(request)
    const next = this.responses.shift()
    if (next?.kind === 'error') throw next.error
    return next?.result ?? { findings: [] }
  }
}
