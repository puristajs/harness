import assert from 'node:assert/strict'
import { createNativePrivacyDetector } from '../dist/index.js'

const detector = createNativePrivacyDetector({ id: 'native-smoke' })
const resultText = 'A😀 email foo@example.test; phone +1 202-555-0123; card 4111 1111 1111 1111; IP 192.168.1.1; IBAN GB82WEST12345698765432; SSN 123-45-6789; https://example.test/path'
const result = await detector.inspect({
  text: resultText,
  entities: ['EMAIL_ADDRESS', 'PHONE_NUMBER', 'CREDIT_CARD', 'IP_ADDRESS', 'IBAN_CODE', 'US_SSN', 'URL'],
  scoreThreshold: 0.5,
  signal: new AbortController().signal
})
assert.deepEqual(result.findings.map((finding) => finding.category), ['EMAIL_ADDRESS', 'PHONE_NUMBER', 'CREDIT_CARD', 'IP_ADDRESS', 'IBAN_CODE', 'US_SSN', 'URL'])
assert.deepEqual(result.findings.map((finding) => resultText.slice(finding.start, finding.end)), ['foo@example.test', '+1 202-555-0123', '4111 1111 1111 1111', '192.168.1.1', 'GB82WEST12345698765432', '123-45-6789', 'https://example.test/path'])

const cancelled = new AbortController()
cancelled.abort()
await assert.rejects(() => detector.inspect({ text: 'foo@example.test', entities: ['EMAIL_ADDRESS'], scoreThreshold: 0.5, signal: cancelled.signal }))
