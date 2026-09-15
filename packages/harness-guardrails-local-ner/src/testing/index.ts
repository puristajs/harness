import type { LocalNerRuntime, LocalNerToken } from '../detector.js'

export { createLocalNerDetectorWithRuntime } from '../detector.js'
export type { LocalNerRuntime } from '../detector.js'

type ScriptedPipeline =
  | { readonly kind: 'result'; readonly tokens: readonly LocalNerToken[] }
  | { readonly kind: 'error'; readonly error: Error }

/** A deterministic, content-free local NER runtime fake for adapter tests. */
export class FakeLocalNerRuntime implements LocalNerRuntime {
  /** Content-free model-load requests. Token-classification text is never recorded. */
  public readonly loads: { readonly modelPath: string; readonly options: { readonly localFilesOnly: true; readonly aggregationStrategy: 'simple' } }[] = []
  private readonly scripted: ScriptedPipeline[] = []

  /** Enqueues aggregate token-classification output for one future inspection. */
  public enqueue(tokens: readonly LocalNerToken[]): void {
    this.scripted.push({ kind: 'result', tokens })
  }

  /** Enqueues a safe intentional pipeline failure for one future inspection. */
  public enqueueError(error: Error = new Error('Fake local NER runtime failure.')): void {
    this.scripted.push({ kind: 'error', error })
  }

  /** Removes load records and scripted token outcomes. */
  public reset(): void {
    this.loads.length = 0
    this.scripted.length = 0
  }

  public async createTokenClassificationPipeline(modelPath: string, options: { readonly localFilesOnly: true; readonly aggregationStrategy: 'simple' }): Promise<(text: string) => Promise<readonly LocalNerToken[]>> {
    this.loads.push({ modelPath, options })
    return async () => {
      const next = this.scripted.shift()
      if (next?.kind === 'error') throw next.error
      return next?.kind === 'result' ? next.tokens : []
    }
  }
}
