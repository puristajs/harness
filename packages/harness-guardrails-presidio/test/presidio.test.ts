import { expect, it } from 'vitest'
import { createPresidioDetector, PresidioSidecarError } from '../src/index.js'
import { FakePresidioSidecar } from '../src/testing/index.js'

it('scripts the narrow Presidio wire contract without emulating recognizers', async () => {
  const sidecar = new FakePresidioSidecar()
  sidecar.enqueueAnalyzeResponse([{ entity_type: 'EMAIL_ADDRESS', start: 0, end: 22, score: 0.99 }])
  const detector = createPresidioDetector({ id: 'presidio-test', endpoint: 'https://presidio.test/', fetch: sidecar.fetch })
  const request = { text: 'synthetic@example.test', entities: ['EMAIL_ADDRESS'], scoreThreshold: 0.6, signal: new AbortController().signal }

  await expect(detector.inspect(request)).resolves.toEqual({ findings: [{ category: 'EMAIL_ADDRESS', start: 0, end: 22, score: 0.99 }] })
  expect(sidecar.requests).toHaveLength(1)
  expect(sidecar.requests[0]).toMatchObject({ url: 'https://presidio.test/analyze', init: { method: 'POST', redirect: 'error' } })
  expect(JSON.parse(String(sidecar.requests[0]?.init.body))).toEqual({ text: request.text, language: 'en', entities: ['EMAIL_ADDRESS'], score_threshold: 0.6, return_decision_process: false })

  sidecar.enqueueTransportError()
  await expect(detector.inspect(request)).rejects.toMatchObject({ kind: 'transport' } satisfies Partial<PresidioSidecarError>)
  sidecar.reset()
  await expect(detector.inspect(request)).resolves.toEqual({ findings: [] })
})

it('sends the narrow Presidio Analyzer contract and converts Python offsets to UTF-16', async () => {
  let init: RequestInit | undefined
  const detector = createPresidioDetector({
    id: 'presidio-private',
    endpoint: 'https://presidio.internal/presidio',
    headers: { authorization: 'Bearer secret-not-for-logs' },
    fetch: async (_input, requestInit) => {
      init = requestInit
      return new Response(JSON.stringify([{ entity_type: 'EMAIL_ADDRESS', start: 2, end: 18, score: 0.99, analysis_explanation: { ignored: true } }]), { status: 200 })
    }
  })
  const request = { text: 'A😀foo@example.test', entities: ['EMAIL_ADDRESS'], scoreThreshold: 0.6, signal: new AbortController().signal }
  await expect(detector.inspect(request)).resolves.toEqual({ findings: [{ category: 'EMAIL_ADDRESS', start: 3, end: 19, score: 0.99 }] })
  expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: expect.objectContaining({ 'content-type': 'application/json' }) })
  expect(JSON.parse(String(init?.body))).toEqual({ text: request.text, language: 'en', entities: ['EMAIL_ADDRESS'], score_threshold: 0.6, return_decision_process: false })
  expect(JSON.stringify(init)).not.toContain('analysis_explanation')
})

it('rejects sidecar faults and malformed payloads without exposing request or response content', async () => {
  const detector = createPresidioDetector({
    id: 'presidio-private',
    endpoint: 'https://presidio.internal/',
    fetch: async () => new Response(JSON.stringify({ error: 'customer@example.test' }), { status: 500 })
  })
  await expect(detector.inspect({ text: 'customer@example.test', entities: ['EMAIL_ADDRESS'], scoreThreshold: 0.6, signal: new AbortController().signal })).rejects.toEqual(expect.objectContaining({ kind: 'http', message: 'Presidio sensitive-data sidecar request failed.' } satisfies Partial<PresidioSidecarError>))
  const malformed = createPresidioDetector({ id: 'presidio-malformed', endpoint: 'https://presidio.internal/', fetch: async () => new Response(JSON.stringify([{ entity_type: 'EMAIL_ADDRESS', start: 0, end: 999, score: 0.9 }]), { status: 200 }) })
  await expect(malformed.inspect({ text: 'customer@example.test', entities: ['EMAIL_ADDRESS'], scoreThreshold: 0.6, signal: new AbortController().signal })).rejects.toEqual(expect.objectContaining({ kind: 'malformed_response' } satisfies Partial<PresidioSidecarError>))
})
