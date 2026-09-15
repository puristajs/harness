interface AbortSignal {
  readonly aborted: boolean
  readonly reason?: unknown
  throwIfAborted(): void
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void
  removeEventListener(type: 'abort', listener: () => void): void
}

declare const AbortSignal: {
  abort(reason?: unknown): AbortSignal
  any(signals: readonly AbortSignal[]): AbortSignal
}

declare const crypto: {
  getRandomValues<T extends ArrayBufferView>(array: T): T
}
