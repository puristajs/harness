# @purista/harness-guardrails-presidio

Original Presidio Analyzer sidecar adapter for
`@purista/harness-guardrails`. Applications provide an authenticated internal
HTTP(S) gateway and any static headers explicitly; the package discovers no
endpoint or credentials and has no retry/fallback behavior.

```ts
import { createPresidioDetector } from '@purista/harness-guardrails-presidio'

const detector = createPresidioDetector({
  id: 'presidio-private',
  endpoint: 'https://presidio.internal/'
})
```

The adapter calls only Presidio Analyzer `POST /analyze`, forces
`return_decision_process: false`, validates results, and converts Python
code-point offsets to JavaScript UTF-16 indexes. It never sends data to
`/anonymize`; masking is performed by the provider-neutral Guardrails addon.
