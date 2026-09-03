# @purista/harness-guardrails-native-privacy

Local-first sensitive-data detector for `@purista/harness-guardrails`. It uses
one Rust Node-API binary family that is tested under Node.js and Bun; it has no
WASM, JavaScript, model, filesystem, or network fallback.

The first release supports only `EMAIL_ADDRESS`, `PHONE_NUMBER`, `CREDIT_CARD`,
`IP_ADDRESS` (IPv4 and IPv6 syntax), `IBAN_CODE`, `US_SSN`, and `URL`. Use the Presidio sidecar adapter
for entities such as `PERSON` or custom/ML recognizers.

```ts
import { createNativePrivacyDetector } from '@purista/harness-guardrails-native-privacy'

const detector = createNativePrivacyDetector({ id: 'native-privacy' })
```

The root package selects a matching signed prebuild for macOS, Linux glibc, or
Windows. Missing/unsupported binaries fail during construction and never fall
back to a different implementation. See the Harness guardrails guide for policy
and telemetry setup.
