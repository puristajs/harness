# Focused Native Privacy Gap-Closure Research and No-Drift Plan

**Status:** Research complete — no implementation authorized by this research alone<br>
**Research date:** 2026-08-24<br>
**Current baseline:** `@purista/harness-guardrails-native-privacy` and the Presidio Analyzer-only sidecar adapter<br>
**Decision owner:** repository owner must approve a follow-up specification before any new capability package or public contract is implemented

## Decision summary

Do not port Presidio. Its Analyzer, Anonymizer, Structured, Image Redactor,
recognizer registry, NLP engines, model lifecycle, and operational APIs are a
separate Python product. The current Harness design correctly owns only one
provider-neutral detection port and deterministic mask/block actions.

Close gaps in three independent, optional tracks:

1. **Native deterministic validation hardening** — improve only the existing
   seven native entity categories and IPv6 without adding an NLP runtime.
2. **Local NER detector** — a new optional package, with explicit local model
   assets and no remote model download, for person/location/organization or
   model-specific categories.
3. **Sensitive-data transformation port** — a separate public port for
   explicit transformations such as HMAC pseudonyms or application-selected
   replacement values. It is not a detector extension and must not default to
   realistic fake data.

Structured/tabular and image/OCR processing are intentionally separate future
products. They require different input contracts, resource limits, retention,
and evaluation methods; none is a safe extension of a string detector.

## User-outcome gap inventory

| User outcome | Current sidecar | Current native | Focused closure |
| --- | --- | --- | --- |
| Detect email, phone, card, IPv4, IBAN, US SSN, HTTP(S) URL | Sidecar recognizer dependent | Format rules; card has Luhn validation | Native validation hardening only where exact semantics are documented |
| Detect IPv6 | Sidecar recognizer dependent | Missing | Add standard-library IPv6 validation after a focused spec/test update |
| Detect names, locations, organizations, medical entities | Sidecar model/recognizer dependent | Missing | Optional local NER package, never bundled into base/native deterministic package |
| Detect organization-specific identifiers | Sidecar custom recognizer dependent | Missing | Application-injected detector now; optional safe native custom-pattern package only after a separate ReDoS-safe design |
| Replace each match with one fixed token or remove it | Yes | Yes | No gap |
| Replace with different values per entity | No | No | Transformation port, not detector work |
| Generate realistic but fictitious identities | No | No | Do not make a first-party privacy default |
| Create stable pseudonyms | No | No | HMAC transformation option with application-owned key provider |
| Hash or encrypt/decrypt a match | No | No | Separate transformation option and cryptographic/key-management specification |
| Process CSV/JSON tables or images/PDF OCR | No | No | Separate structured/image packages; do not fold into Guardrails text flow |

## Candidate dependency assessment

| Candidate | Potential gap closed | Evidence and fit | Decision |
| --- | --- | --- | --- |
| Rust standard library `std::net::Ipv6Addr` | IPv6 validation | No new dependency, portable Rust, exact parse validation | Preferred for a focused IPv6 addition |
| [`iban_validate`](https://docs.rs/iban_validate) v5 | Full IBAN/BBAN validation | Apache-2.0, safe-Rust/no-std design, typed errors and test claims; not controlled by a major vendor | Candidate only after dependency/SBOM/license/maintenance audit; do not adopt merely to replace a regex |
| [`rlibphonenumber`](https://github.com/vloldik/rlibphonenumber) v2 | International phone extraction/validation | Apache-2.0 Rust port of Google libphonenumber metadata; active but independently maintained | Spike candidate, not a default commitment; measure binary size, metadata-update process, correctness and macOS/Linux/Windows Node/Bun builds |
| [`@microsoft/recognizers-text-sequence`](https://github.com/microsoft/Recognizers-Text) | Phone, IP including IPv6, email and URL extraction | Microsoft, MIT, TypeScript package; last published npm JavaScript release is 1.3.1 from 2023 and no repository Bun support claim | Do not add as a production dependency; may be a benchmark/oracle input only |
| [`@huggingface/transformers`](https://github.com/huggingface/transformers.js) v4 | Local ONNX token classification / NER | Hugging Face, Apache-2.0; official v4 material claims Node and Bun support | Conditional candidate for a new optional NER package. Require real Node/Bun CI with pinned local model artifacts; never allow first-request download. Bun compiled-binary issues remain open and must be assessed separately. |
| [`@faker-js/faker`](https://github.com/faker-js/faker) | Realistic replacement values | MIT, active TypeScript package with locale data, but its own docs warn generated values can coincide with real data | Reject as a first-party privacy transformation default. It is acceptable only in user-owned test fixtures or an explicitly chosen application adapter, never as automatic anonymization. |

## Recommended package boundaries

```text
@purista/harness-guardrails
  SensitiveDataDetector                    # existing detection port
  SensitiveDataTransformer                 # future, separately specified

@purista/harness-guardrails-native-privacy
  deterministic identifier detection only  # current package, hardened subset

@purista/harness-guardrails-local-ner      # future optional package
  explicit local ONNX model + label mapping # no remote download/fallback

@purista/harness-guardrails-transforms      # future optional package
  HMAC pseudonym / fixed replacement only   # key supplied by application
```

The base package never imports model, crypto-key, Faker, Presidio, image, or
table-processing dependencies. Each optional package implements the public
port and carries its own runtime, model/binary, supply-chain, and test policy.

## Required follow-up specifications

### A. Native deterministic hardening

Write a small amendment before implementation that fixes exact semantics for:

- `IP_ADDRESS`: add IPv6, or introduce separate `IPV4_ADDRESS`/`IPV6_ADDRESS`
  categories; do not silently change category semantics.
- `IBAN_CODE`: define whether acceptance requires MOD-97 and current country
  registry validation, then compare current regex behavior against a pinned
  corpus.
- `PHONE_NUMBER`: define whether detection is permissive extraction or valid
  international numbering-plan validation. Do not treat a format match as a
  valid assigned number.
- `US_SSN`, email and URL: define exactly whether only syntax is promised, and
  document false-positive/false-negative limits.

Acceptance gates: exhaustive category fixtures, adversarial bounds tests,
native Node and Bun smoke tests on macOS/Linux/Windows, benchmark guardrails,
SBOM/license scan, package dry run, and outcome-matrix updates.

### B. Optional local NER detector spike

Do not publish a package before this spike passes all gates:

1. Pin `@huggingface/transformers` and one small ONNX token-classification
   model with their individual licenses, SHA-256 digests, source URLs and size
   budget. Model licensing is independent of package licensing.
2. Require a composition-root `modelPath`, approved label-to-portable-entity
   mapping, score threshold and explicit model identity. Set remote-model
   loading to disabled; no environment lookup or automatic cache/download.
3. Prove ordinary Node.js and ordinary Bun execution on macOS/Linux/Windows.
   Treat `bun --compile` as a separate unsupported mode until upstream support
   is verified; current upstream reports unresolved compiled-binary failures.
4. Define bounded text/memory/model-load limits, cancellation, warmup, model
   integrity failure, malformed labels and content-free OTel/error behavior.
5. Establish precision/recall fixtures for every published entity/language.
   “NER” must never mean “all PII is found.”

If any gate fails, retain the Presidio sidecar for that capability.

### C. Transformation port

Design a new provider-neutral `SensitiveDataTransformer` only after approving
the following contract decisions:

- input is the validated finding plus application-selected entity policy, never
  an arbitrary recursive JSON value;
- choices are explicit per entity: fixed replacement, remove, HMAC pseudonym,
  or application implementation; no automatic “fake person/address” default;
- HMAC/encryption keys come from an application-owned secret/key provider and
  never YAML, spans, logs, errors, snapshots, test records, or package config;
- transformations preserve or intentionally change value length only by
  documented policy; overlapping results remain invalid;
- every transform runs under content-free Guardrail telemetry with no model or
  token/cost attributes;
- reversible encryption, persistence of mapping tables, and deanonymization
  are separate high-risk capabilities, not initial scope.

Use Web Crypto / Node `crypto` primitives for a future HMAC implementation
rather than introducing a provider SDK. A security review and test vectors are
mandatory before release.

## Explicit non-goals for the next focused iteration

- Full Presidio Analyzer/Text Anonymizer parity.
- Python, Docker, sidecar, cloud, or provider SDK dependencies in the native
  package.
- Browser-direct PII processing through a remote detector.
- Auto-downloading model assets or silently falling back between detectors.
- Shipping realistic identity generation as a privacy feature.
- CSV/JSON table, PDF/image/OCR, DICOM or batch-processing APIs.

## Source record

- Presidio documents Analyzer detection, Anonymizer transforms, structured data
  and image redaction as separate modules: official Presidio docs, accessed
  2026-08-24.
- Microsoft Recognizers Text is MIT and offers TypeScript sequence recognition,
  but the current npm JavaScript release is from 2023: official repository/npm,
  accessed 2026-08-24.
- Hugging Face Transformers.js is Apache-2.0 and supports token
  classification/NER. Its v4 release states Node/Bun support, while upstream
  still reports Bun compiled-binary issues: official docs/repository/issues,
  accessed 2026-08-24.
- `iban_validate` and `rlibphonenumber` are independent Rust candidates, not
  vendor-backed dependencies. Their adoption needs the stated supply-chain
  audit rather than an assumption of institutional support.
- Faker is MIT and active but warns realistic outputs may coincide with real
  data: official project documentation, accessed 2026-08-24.
