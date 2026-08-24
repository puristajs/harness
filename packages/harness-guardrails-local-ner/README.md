# @purista/harness-guardrails-local-ner

Optional local token-classification/NER detector for
`@purista/harness-guardrails`. It keeps model inference in-process and uses an
application-provisioned model directory. It does not bundle a model, download
model files, configure a model registry, or fall back to a remote service.

Install it only where model-based entity recognition is required:

```sh
npm install @purista/harness-guardrails-local-ner @huggingface/transformers
```

```ts
import { createLocalNerDetector } from '@purista/harness-guardrails-local-ner'
import { NER_EN_V1_ASSETS } from './models/ner-en-v1.integrity.js'

const detector = createLocalNerDetector({
  id: 'ner-en',
  modelId: 'ner-en-v1',
  modelPath: '/srv/purista-models/ner-en-v1',
  modelFiles: NER_EN_V1_ASSETS,
  labels: { PER: 'PERSON', ORG: 'ORGANIZATION', LOC: 'LOCATION' },
})

await detector.warmup()
```

`modelPath` must be an absolute directory containing already provisioned model
assets. `NER_EN_V1_ASSETS` is an application-owned list of every required file
and its lower-case SHA-256 digest; warmup verifies it before the runtime loads.
`labels` is an explicit mapping from the selected model's aggregate labels to
your portable Guardrails entity categories. Only mapped and requested categories
are returned. The adapter is not a promise that all PII is found; evaluate the
selected model and labels for every deployed language and entity.

If `@huggingface/transformers` is not installed, warmup and inspection throw a
content-free `LocalNerDetectorError` with
`kind: 'missing_optional_dependency'` and the exact installation command. When
used through Guardrails, the failure stays fail-closed and is observable as
`harness.sensitive_data.failure_kind=missing_optional_dependency` without
recording inspected text, local paths, model output, or credentials.

Use `FakeLocalNerRuntime` from
`@purista/harness-guardrails-local-ner/testing` to test label mapping and error
paths deterministically. It scripts model output and never records inspected
text.
