# Presidio TypeScript Port Feasibility Research

**Status:** Research complete — native deterministic subset authorized by `specs/31-sensitive-data-guardrails.md`; full Presidio parity remains unauthorized<br>
**Research date:** 2026-08-24<br>
**Target baseline:** Data Privacy Stack Presidio `main`, shallow-cloned on 2026-08-24; Analyzer and Anonymizer `2.2.364` in their `pyproject.toml` files<br>
**Harness baseline:** `ai-harness` commit `1dd9cce` on `feat/nemo-guardrails-harness`

## Executive verdict

It is legally and technically possible to create a TypeScript implementation derived from Presidio’s text components. Presidio is MIT-licensed, provided copyright/license notices are retained. It is **not** possible to obtain complete Presidio Analyzer parity by assembling existing TypeScript dependencies.

There are strong TypeScript/JavaScript building blocks for selected capabilities—ONNX inference, token classification, phone parsing, public-suffix lookup, YAML validation, and cryptographic primitives. None replaces spaCy, Stanza, Presidio’s recognizer/configuration runtime, its context scoring, or its 99 recognizer implementations with matching semantics. A product called a “full Presidio TypeScript port” would be an independently maintained privacy engine, with an estimated **12–24 engineer-month** initial delivery for Analyzer-plus-text-Anonymizer parity and a permanent upstream compatibility commitment.

For AI Harness, the correct near-term architecture remains:

1. `@purista/harness-guardrails` owns the public `SensitiveDataDetector`/privacy-adapter contract, deterministic masking action, privacy-safe telemetry, and NeMo-shaped policy mapping.
2. `@purista/harness-guardrails-presidio` is an optional local adapter to the maintained upstream Python service.
3. The approved native implementation is a separately versioned optional detector package named **native privacy**, not “Presidio-compatible”. It must never claim Presidio parity unless it later passes an approved differential corpus against a pinned Presidio release.

## Scope definitions

| Term | Meaning in this research |
| --- | --- |
| **Thin Presidio adapter** | TypeScript implementation of the Guardrails detector port that calls a locally deployed Presidio Analyzer endpoint and validates the response. It does not reproduce Presidio logic. |
| **Native rule detector** | New TypeScript detector with explicitly selected regex/checksum/entity recognizers. It intentionally has a smaller published capability contract. |
| **Text parity port** | Analyzer plus text Anonymizer behavior compatible with a pinned upstream Presidio release for documented configuration, inputs, and outputs. |
| **Whole-suite port** | Text parity plus Presidio Structured and Image Redactor. This is outside the Harness/Guardrails use case and is not a viable initial target. |

## Evidence from the upstream source audit

The source snapshot is reproducible with:

```sh
git clone --depth 1 https://github.com/data-privacy-stack/presidio.git /private/tmp/presidio-port-research
```

| Component | Python source | Tests | Port significance |
| --- | ---: | ---: | --- |
| `presidio-analyzer` | 173 files / 19,617 LOC | 144 files / 24,146 LOC | Main detection engine, registry, configuration, context scoring, NLP integration, and recognizers. |
| Predefined recognizers | 99 recognizer classes / 11,293 LOC | included above | Generic and country-specific regex/checksum/entity logic plus remote/model-backed recognizers. |
| NLP engine layer | 1,913 LOC | included above | spaCy default plus Stanza and Transformers integrations, token/lemma/entity artifacts, batching, model loading. |
| Registry/context/engine core | 1,951 LOC | included above | YAML-driven recognizer registry, resolver, score thresholds, conflict resolution, context enhancement. |
| `presidio-anonymizer` | 36 files / 2,467 LOC | 33 files / 4,017 LOC | Replacement/redaction/masking/hash/encryption/decryption/custom operators and overlapping-span handling. |
| `presidio-structured` | 13 files / 1,255 LOC | 5 test files | Pandas-backed data-frame profiling and anonymization; separate product scope. |
| `presidio-image-redactor` | 34 files / 7,751 LOC | 18 test files | OCR, image/DICOM handling, OpenCV, Tesseract, Azure Document Intelligence; separate product scope. |

The Analyzer default configuration selects a spaCy model (`en_core_web_lg`), maps NER labels to Presidio entities, applies low-confidence treatment, and loads a configurable registry of generic and country-specific recognizers. The Analyzer accepts ad-hoc recognizers, language, entity selection, thresholds, context, allow-lists, configurable regex flags, and precomputed NLP artifacts. These are observable API semantics, not internal implementation detail.

The source uses Python’s third-party `regex` engine with explicit per-match timeouts. It contains inline flag patterns such as `(?i)` that native ECMAScript regular expressions do not parse. It also uses Python string offsets; TypeScript strings index UTF-16 code units. Any native implementation must define/translate offset behavior for astral Unicode characters before it can claim result-span parity.

## Upstream status, license, and supply-chain facts

- The project originated at Microsoft and has moved to the [Data Privacy Stack Presidio repository](https://github.com/data-privacy-stack/presidio). Upstream describes the project as a PII detection and de-identification SDK and states the repository is now in a new home. [Repository overview](https://github.com/data-privacy-stack/presidio)
- The repository is MIT licensed. Derivative source must retain the applicable copyright/license notices. The aggregate upstream `NOTICE` file also includes notices for incorporated third-party materials; a real port requires legal/supply-chain review of every copied file and model, not a blanket “MIT” label.
- Current upstream installation documentation says the old Microsoft Container Registry images are no longer updated and directs production users to explicit release tags under `ghcr.io/data-privacy-stack`. [Installation guidance](https://github.com/data-privacy-stack/presidio/blob/main/docs/installation.md)
- Presidio’s REST containers intentionally do not provide authentication/authorization; deployment needs an application-owned gateway, reverse proxy, or service mesh. [Upstream FAQ](https://github.com/data-privacy-stack/presidio/blob/main/docs/faq.md)

## Dependency-by-dependency TypeScript feasibility

| Presidio capability/dependency | TypeScript/JavaScript building block | Port status | Required conclusion |
| --- | --- | --- | --- |
| YAML configuration (`PyYAML`) | Existing `yaml` package | Direct | Parsing is trivial; Presidio configuration behavior is not. Keep only a tightly specified portable subset in Guardrails. |
| Schema/model validation (`Pydantic`) | Existing `zod` package | Direct | Types and validation can be expressed idiomatically in the Guardrails package. |
| Simple pattern recognizers | Native `RegExp` plus explicit TypeScript validators | Partial | Many patterns translate, but all must be reviewed and differential-tested. Preserve explicit limits and validation; do not copy raw pattern files blindly. |
| Python `regex` engine and timeout | No native ECMAScript equivalent | Blocking for parity | ECMAScript lacks Python `regex` timeout APIs and does not accept inline flags such as `(?i)`. RE2-like engines reduce ReDoS risk but have a different feature set, so they are not parity replacements. A native engine requires a pattern compatibility compiler, explicit safe-regex policy, worker/process isolation or another cancellation boundary, and a documented non-parity mode. |
| `phonenumbers` | [`libphonenumber-js`](https://github.com/catamphetamine/libphonenumber-js) | Useful but non-proven parity | It supports parsing/validation and searching phone numbers in text. Its metadata/version and extraction behavior must be differential-tested against the exact Python `phonenumbers` version before it is used for a Presidio-derived recognizer. |
| `tldextract` | [`tldts`](https://www.npmjs.com/package/tldts) | Useful but non-proven parity | It provides public-suffix, URL, host and email parsing with TypeScript types. Public Suffix List snapshot and URL edge-case behavior must be pinned and tested against `tldextract`. |
| Checksums / validators | Native TypeScript arithmetic and `node:crypto` | Direct for algorithms | Luhn, IBAN mod-97, national identifier checks, SHA-256 and AES can be written/run locally. Exact formatting, error types, encoding, padding, conflict resolution, and test vectors still require port work. |
| Presidio Anonymizer `replace`, `redact`, basic `mask` | TypeScript string reconstruction | Direct for the Guardrails use case | Guardrails needs only deterministic full-span replacement. Its action factory can do this without a Presidio Anonymizer process. Full operator compatibility needs separate work. |
| Presidio Anonymizer `hash`, AES encrypt/decrypt, custom operators, AHDS surrogate | `node:crypto` for primitives; no generic replacement for the rest | Partial | Node crypto does not guarantee upstream ciphertext/output compatibility. Need pinned cross-language test vectors, key/IV/encoding compatibility, and explicit non-portability of custom/AHDS operators. |
| spaCy default NLP / NER | No maintained TypeScript spaCy runtime | Blocking for parity | Presidio’s default engine consumes spaCy token, lemma, stop-word, punctuation, entity, score, and model behavior. There is no drop-in Node/TypeScript equivalent. |
| Stanza engine | No maintained TypeScript Stanza runtime | Blocking for parity | Reproducing Presidio’s Stanza-to-spaCy artifact adapter would require implementing/embedding its model runtime and token semantics. |
| Hugging Face Transformers engine | [`@huggingface/transformers`](https://huggingface.co/docs/transformers.js/en/index) plus [`onnxruntime-node`](https://onnxruntime.ai/docs/get-started/with-javascript/node.html) | Possible new engine, not parity | Transformers.js supports Node inference and token classification/NER through ONNX Runtime. It does not run spaCy pipelines or make their tokenization, score aggregation, alignment, or models equivalent. Model artifacts must be local/pinned and remote downloads disabled in production. |
| GLiNER recognizer | Community `gliner` / `@lmoe/gliner-onnx` packages; ONNX Runtime | Experimental only | There are TypeScript packages, but their maturity, model conversion, tokenizer, span overlap, output score, and operational guarantees differ from Presidio’s Python GLiNER integration. They cannot be a production-default compatibility dependency without a separate supply-chain and differential-evaluation approval. |
| Azure remote recognizers | Official Azure Node SDKs | Adapter only | They can implement the Guardrails detector port but do not make a local TypeScript Presidio port. Cloud egress remains optional and excluded from the first release. |
| Structured data (`pandas`) | None that recreates Pandas/Presidio semantics | Separate project | Not in the Harness value path. Do not include in any text-port estimate. |
| Image/DICOM/OCR redaction | Node image/OCR packages exist, but no Presidio parity stack | Separate project | Requires image, OCR, DICOM, model, performance and security programs. Do not include in a text-port package. |

## What existing JavaScript runtimes do and do not unlock

### ONNX and Transformers.js

Hugging Face’s Transformers.js supports token-classification/NER and server-side Node execution. In Node it uses `onnxruntime-node`; ONNX Runtime ships Node bindings for common x64/arm64 operating systems. [Transformers.js pipeline reference](https://huggingface.co/docs/transformers.js/en/api/pipelines) and [ONNX Node reference](https://onnxruntime.ai/docs/get-started/with-javascript/node.html)

This makes a **new local NER detector** feasible. It does not preserve Presidio’s default spaCy model, token boundaries, lemma/context enhancement, model-label mapping, aggregation/alignment implementation, confidence values, or installed model behavior. A model download on first use is also unacceptable for a local privacy control; Transformers.js supports local models and disabling remote loading, which must be required by a future native detector spec. [Local model configuration](https://huggingface.co/docs/transformers.js/main/en/custom_usage)

### GLiNER

The Presidio Analyzer already has an optional Python GLiNER recognizer. A community TypeScript package, `gliner`, provides ONNX-based TypeScript inference and typed results, but it is not a Presidio upstream package and its npm release history is sparse. It is a viable **research spike**, not a dependency for a compatibility claim or production default. [GLiNER.js package information](https://www.npmjs.com/package/gliner)

### Rule and utility recognizers

`libphonenumber-js` and `tldts` are credible building blocks for phone and public-suffix/URL work. They reduce implementation effort but introduce their own versioned metadata and edge-case semantics. A port must use Presidio’s upstream test corpus plus additional differential cases; “both accept the same obvious phone number” is not compatibility evidence.

## Rust and WebAssembly assessment

### Verdict

Rust is the preferred implementation language for a future **native deterministic** privacy detector. It gives the engine an explicit binary/package boundary, reliable integer/checksum implementations, strong control over memory allocation, and a safe-regex option that avoids Node’s backtracking/event-loop failure mode.

The required runtime targets are **Node.js and Bun**. Ship a prebuilt Rust Node-API addon for both; WASM/WASI is explicitly out of scope for the first native package. Do not create a runtime fallback to a weaker detector when a trusted native binary is unavailable. Configuration must fail during startup with a clear bounded diagnostic.

### Existing `presidio-rs` project

The community [`jqueguiner/presidio-rs`](https://github.com/jqueguiner/presidio-rs) project is a substantive Rust implementation, not merely a wrapper. Its 2026-07-19 source snapshot contains 43 Rust files / 7,355 LOC, an Analyzer, text Anonymizer, CLI, Axum REST service, Python bindings, approximately 61 documented entity types, optional Gazetteers, and an optional Candle NER crate. Its authors describe it as a Presidio architecture port and document Presidio-shaped HTTP endpoints. [Project README](https://github.com/jqueguiner/presidio-rs)

It is nevertheless **not a drop-in candidate** for `@purista/harness-guardrails`:

1. It has no Node-API, npm, `wasm-bindgen`, or first-class WASM package target. A Cargo workspace contains Rust libraries, server/CLI and Python bindings only.
2. The project’s own stated NER model and Gazetteer features lazily download/caches model/data artifacts. That violates the Guardrails requirement that a local privacy control has no runtime remote model/data download; model/data artifacts must be application-pinned, integrity-checked, provisioned before startup, and loaded from an explicit local path.
3. The source uses Rust `regex`, whose match offsets are byte offsets. Guardrails TypeScript values use UTF-16 code-unit positions. An adapter must define and test a conversion contract for non-ASCII text before any transformation can be safe.
4. The Rust project makes broad parity claims, but this research found no pinned Presidio-version differential corpus, published allowed-divergence rules, or Node/WASM release matrix. Treat its claims as project assertions, not our acceptance evidence.
5. It is a small community project; integration needs a full supply-chain assessment, license/NOTICE review, maintenance-owner decision, and a fork/patch policy. It is not an official Presidio replacement.

It is valuable as a **reference and potential upstream collaboration/spike**, but the first local integration should still use the maintained Python Presidio service. Do not vendor or depend on it in the first Guardrails release.

### Safe regex: an advantage with a compatibility cost

The Rust `regex` crate intentionally omits look-around and backreferences in exchange for bounded search behavior. Its documented worst-case search cost is `O(m * n)` for a pattern of size `m` and haystack size `n`; iterating all matches can still be quadratic without an explicit earliest-match strategy and input limits. [Rust regex security/performance documentation](https://docs.rs/regex/latest/regex/)

This is a strong safety improvement for a new native detector. It is not Presidio/Python-regex parity. The native specification must publish an allow-list of supported pattern syntax, compile all built-in patterns at build/test time, reject unsupported custom patterns at configuration load, cap pattern count/length and input byte length, limit output findings, and use a bounded scan strategy. It must never silently alter or accept Python-compatible YAML regex semantics.

### Node.js and Bun native-runtime contract

| Runtime target | Support decision | Evidence | Release requirement |
| --- | --- | --- | --- |
| Node.js | Required | Node-API is ABI-stable across supported Node releases when the addon uses a selected stable API level and no unstable Node/V8 interfaces. [Node-API documentation](https://nodejs.org/api/n-api.html) | Publish and test every declared OS/architecture binary with the repository’s supported Node versions. |
| Bun | Required | Bun documents direct loading of `.node` Node-API modules and identifies Node-API as its production-stable native-code interface. Bun states that most existing addons work, not that all Node-API behavior is complete. [Bun Node-API documentation](https://bun.sh/docs/runtime/node-api) and [Bun FFI guidance](https://bun.sh/docs/runtime/ffi) | Run the identical package contract/integration suite under a pinned supported Bun version on every published OS/architecture. A Node pass is not evidence of Bun support. |
| WASM/WASI/browser | Not supported in v1 | No product requirement | Do not publish a loader, fallback, or documentation claim. A later browser/WASM proposal must receive separate approval. |

The native package uses `napi-rs` and only stable Node-API primitives. It must not use `bun:ffi`: Bun classifies that API as experimental and specifically recommends Node-API as the stable production path. It must not use V8 APIs, Node C++ APIs, `NAPI_EXPERIMENTAL`, runtime code compilation, environment-variable-controlled binary selection, or a JavaScript fallback implementation.

`napi-rs` itself carries a Bun test in its repository, which is useful evidence that the toolchain is exercised with Bun. It does not substitute for testing this detector’s actual async, cancellation, typed-array/string conversion, error propagation, and shutdown behavior. [napi-rs Bun test evidence](https://github.com/napi-rs/napi-rs/blob/main/package.json)

### Required Node/Bun compatibility spike before a native implementation wave

The native-detector specification must make this a blocking, time-boxed spike before recognizer work begins:

1. Build a minimal `napi-rs` Rust package exposing `inspect(text: Uint8Array, signal?: AbortSignal): Promise<InspectionResult>` using only the selected stable Node-API surface.
2. Publish no package. In CI, load the same platform `.node` artifact through the normal npm package loader under Node and Bun; do not use `process.dlopen` only in one runtime and a different code path in the other.
3. Assert the full contract in both runtimes: ESM import, typed-array input/output, UTF-8 decoding rejection, astral-Unicode offset conversion, large bounded input rejection, Promise resolution, failure mapping, repeated concurrent calls, cancellation before/during work, addon shutdown, and no event-loop blocking beyond the approved bound.
4. Test every published target triple under Node and Bun. The exact Node LTS versions, Bun minimum version, operating systems, CPU architectures, libc variants, and package-manager install modes must be frozen in the native-detector spec before release.
5. If any required Node/Bun matrix cell fails, the native detector remains unreleased and applications use the already supported injected Presidio adapter. Do not ship a runtime-specific behavior difference or a degraded fallback.

### Performance claim policy

Do not claim that native Rust is faster before benchmark evidence. The likely server-side benefit comes from a bounded Rust engine and moving work off the JavaScript event loop, but JavaScript-to-native conversion, model initialization, artifact size, and actual entity mix can reverse micro-benchmark results. The approved native-detector spec must require benchmark fixtures with synthetic non-sensitive corpus, cold/warm startup measurements, p50/p95/p99 latency, throughput, RSS/heap, CPU, artifact size, and error/cancellation behavior for Node and Bun separately.

## Compatibility blockers that must be solved, not hand-waved

1. **NLP model parity:** spaCy/Stanza models and their token/lemma/entity/score semantics do not run in TypeScript. A model conversion is a new backend, not the same backend.
2. **Unicode offsets:** Python exposes character-index offsets; JavaScript uses UTF-16 code-unit indices. Inputs containing astral-plane characters can produce different spans and incorrect redaction unless an explicit conversion layer and tests exist.
3. **Regex safety and semantics:** Presidio uses Python `regex` with timeouts. JavaScript’s regex execution has no equivalent timeout and differs in syntax/Unicode behavior. Porting patterns without a safety boundary risks event-loop blocking and ReDoS.
4. **Score/conflict/context semantics:** Presidio combines recognizer scores, recognizer-specific thresholds, entity thresholds, duplicates, overlaps, context words, and NLP artifacts. Matching a regex is insufficient.
5. **Configuration compatibility:** upstream accepts registry YAML, custom recognizers, country filters, NER mappings, model settings, allow-list modes, and ad-hoc recognizers. A native TypeScript engine needs a versioned subset instead of accepting fields it cannot honor.
6. **External recognizers:** Azure AI Language, Azure Health Data Services, language-model extraction, and GLiNER are optional Python integrations. They must either be excluded or become separate guarded adapter packages; no automatic provider choice is permitted.
7. **Regression oracle:** a compatible port needs a pinned Presidio container in the test environment, fixture sanitization, differential output comparison, and a release policy for upstream changes. It cannot treat one-time unit tests as sufficient.
8. **Whole-suite scope:** structured and image components are independent programs with data-frame/OCR/image/DICOM dependencies. They do not belong in the Guardrails addon or in the initial native-detector effort.

## Delivery options and realistic effort

Estimates include implementation, deterministic tests, privacy/Otel constraints, documentation, packaging, and review; they exclude production deployment/SRE ownership. They are planning ranges, not delivery commitments.

| Option | Scope | Estimate | Verdict |
| --- | --- | ---: | --- |
| A. Local Presidio adapter | Guardrails public port plus validated local REST adapter; masking remains in TypeScript | 1–2 engineer-weeks after the approved Guardrails sensitive-data spec | Recommended first release. |
| B. Native deterministic starter detector | Typed registry and 10–20 selected generic/country-specific rule/checksum recognizers; no NER/ML/config parity | 8–14 engineer-weeks | Viable separate optional package after a domain/entity list and adversarial corpus are approved. Market as native privacy, never Presidio parity. |
| C. Broad native rule engine | Most 99 recognizers, config subset, pattern compatibility/safety, scoring/context/conflict engine, phone/domain mappings | 6–10 engineer-months | Possible only with committed long-term maintainership; still no spaCy/Stanza parity. |
| D. Text parity program | Broad rule engine plus one pinned ONNX NER backend, anonymizer operators, differential oracle, upstream tracking and release process | 12–24 engineer-months | Technically possible; high-risk product program. Do not start inside the Guardrails feature wave. |
| E. Whole Presidio suite | Text parity plus structured and image/DICOM/OCR components | Multi-year multi-team program | Reject for Purista/Harness. |

The Anonymizer itself is not the expensive part for the currently planned rail behavior: reverse-order full-span replacement is small and deterministic. Its full operator set, encryption compatibility, conflict-resolution choices, batch behavior, and custom operator framework are a separate compatibility commitment.

## Recommended package shape if native work is approved

The public adapter interface remains only in `@purista/harness-guardrails`:

```text
@purista/harness-guardrails
  └─ exports SensitiveDataDetector, policy/action factory, codecs and telemetry

@purista/harness-guardrails-presidio
  └─ implements SensitiveDataDetector over injected local Presidio transport

@purista/harness-guardrails-native-privacy
  └─ implements SensitiveDataDetector using a clearly versioned, native capability set

@purista/harness-guardrails-native-privacy-onnx
  └─ optional future local-only NER implementation; owns model asset verification
```

`@purista/harness-guardrails-native-privacy` must have no cloud provider SDK, no runtime model download, no credentials, and no import from the Presidio adapter. The ONNX package must be optional because native bindings and model artifacts materially change installation, supply chain, startup time, and platform support.

## Required gate before any port begins

Do not add a “Presidio TypeScript port” implementation ticket until a repository owner approves a dedicated native-privacy specification containing all of the following:

- A precise target: Option B, C, or D above; “port Presidio” is not sufficient.
- A pinned Presidio source release/commit, copied-file inventory, LICENSE/NOTICE obligations, package naming decision, and legal review of model licenses.
- An exact entity/language/country list, recognizer map, configuration subset, operator list, regex policy, maximum text length, concurrency/memory limits, and behavior for unsupported fields.
- A canonical Unicode-offset contract for all public TypeScript results and a test matrix containing BMP, astral-plane, combining-character, RTL, and mixed-language cases.
- A pattern security design that prevents event-loop blocking and produces deterministic timeout/failure behavior without exposing content in logs, errors, traces, or fixtures.
- A pinned local model/artifact distribution and integrity policy for any ONNX backend; remote model download is prohibited at runtime.
- A differential test harness against a pinned local Presidio container, with sanitized synthetic fixtures, allowed-divergence rules, score tolerance rules, and CI matrix.
- OTel spans/metrics/logging that remain content-free, plus model/artifact load telemetry that does not misuse LLM token/cost attributes.
- A maintenance owner and an upstream-watch/release policy; Presidio adds recognizers, models, and behavior over time.

Until these gates are approved, only the public Guardrails privacy port and the local Presidio adapter may proceed under the existing sensitive-data guardrails spec-closure plan.
