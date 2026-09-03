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

## Deterministic testing

Use the test-only helper instead of a live sidecar in unit and adapter-contract
tests. It scripts the HTTP protocol; it does not emulate Presidio recognizers
or NLP behavior.

```ts
import { createPresidioDetector } from '@purista/harness-guardrails-presidio'
import { FakePresidioSidecar } from '@purista/harness-guardrails-presidio/testing'

const sidecar = new FakePresidioSidecar()
sidecar.enqueueAnalyzeResponse([])
const detector = createPresidioDetector({
  id: 'presidio-test',
  endpoint: 'https://presidio.test/',
  fetch: sidecar.fetch,
})
```

`sidecar.requests` is test-only in-memory request data. Do not copy it to logs,
snapshots, or telemetry.
