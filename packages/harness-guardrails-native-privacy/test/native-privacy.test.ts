import { expect, it } from 'vitest'
import { createNativePrivacyDetector, NATIVE_PRIVACY_SUPPORTED_ENTITIES } from '../src/index.js'
import type { NativePrivacyBinding } from '../src/native-loader.js'

it('exposes only the documented native capability subset and forwards the abort protocol', async () => {
  const calls: string[] = []
  const binding: NativePrivacyBinding = {
    async inspect(requestId, text, entities, scoreThreshold) {
      calls.push(`${requestId}:${text}:${entities.join(',')}:${scoreThreshold}`)
      return [{ category: 'EMAIL_ADDRESS', start: 3, end: 19, score: 1 }]
    },
    cancel(requestId) { calls.push(`cancel:${requestId}`) }
  }
  const detector = createNativePrivacyDetector({ id: 'native-test', binding })
  await expect(detector.inspect({ text: 'A😀foo@example.test', entities: ['EMAIL_ADDRESS'], scoreThreshold: 0.6, signal: new AbortController().signal })).resolves.toEqual({ findings: [{ category: 'EMAIL_ADDRESS', start: 3, end: 19, score: 1 }] })
  expect(detector.supportedEntities).toEqual(NATIVE_PRIVACY_SUPPORTED_ENTITIES)
  expect(calls).toHaveLength(1)
})

it('fails before native execution when the caller has cancelled the guardrail budget', async () => {
  const controller = new AbortController()
  controller.abort()
  const detector = createNativePrivacyDetector({ id: 'native-test', binding: { inspect: async () => [], cancel: () => undefined } })
  await expect(detector.inspect({ text: 'customer@example.test', entities: ['EMAIL_ADDRESS'], scoreThreshold: 0.6, signal: controller.signal })).rejects.toMatchObject({ kind: 'aborted', message: 'Native privacy detector is unavailable.' })
})
