import type { SensitiveDataDetector, SensitiveDataFinding, SensitiveDataInspectionRequest, SensitiveDataInspectionResult } from '../sensitive-data.js'

/** A deterministic, content-free sensitive-data detector for application and addon tests. */
export class FakeSensitiveDataDetector implements SensitiveDataDetector {
  public readonly id: string
  public readonly executionMode = 'local' as const
  public readonly supportedEntities?: readonly string[]
  public readonly requests: SensitiveDataInspectionRequest[] = []
  private readonly responses: SensitiveDataInspectionResult[] = []

  /**
   * @param options Stable fake identity and optional declared capabilities.
   * @example
   * const detector = new FakeSensitiveDataDetector({ supportedEntities: ['EMAIL_ADDRESS'] })
   */
  public constructor(options: { id?: string; supportedEntities?: readonly string[] } = {}) {
    this.id = options.id ?? 'fake-sensitive-data-detector'
    if (options.supportedEntities) this.supportedEntities = options.supportedEntities
  }

  /** Enqueues the result returned by the next inspection, or an empty result by default. */
  public enqueue(findings: readonly SensitiveDataFinding[]): void {
    this.responses.push({ findings })
  }

  public async inspect(request: SensitiveDataInspectionRequest): Promise<SensitiveDataInspectionResult> {
    this.requests.push(request)
    return this.responses.shift() ?? { findings: [] }
  }
}
