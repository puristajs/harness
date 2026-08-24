# AI Harness ecosystem and packages

The Harness runtime is provider-neutral and dependency-light by default.
Install the core package, one provider adapter, and only the optional packages
that enforce a boundary your application actually needs.

| Package | Purpose | Minimal setup | More detail |
| --- | --- | --- | --- |
| `@purista/harness` | Typed runtime for models, tools, skills, agents, workflows, sessions, state, sandboxes, evaluation, and telemetry. | `npm install @purista/harness`; build through `defineHarness()`. | [Configuration](./configuration.md), [tools & skills](./tools-and-skills.md), [workflows](./workflows.md) |
| `@purista/harness-openai` | OpenAI and compatible model provider. | `openai({ apiKey, api? })`; register under a model alias. | [Configuration](./configuration.md) |
| `@purista/harness-anthropic` | Anthropic model provider. | `anthropic({ apiKey })`; register under a model alias. | Package README |
| `@purista/harness-bedrock` | Amazon Bedrock provider. | `bedrock({ region })`; use the AWS credential chain. | Package README |
| `@purista/harness-azure-foundry` | Azure AI Foundry provider. | `azureFoundry({ endpoint, apiKey or credential })`. | Package README |
| `@purista/harness-guardrails` | Ordered fail-closed input, output, tool, retrieval, and model-check controls. | Load policy YAML, provide TypeScript actions, call `rails.attach(...)`. | [Guardrails](./guardrails.md) |
| `@purista/harness-guardrails-presidio` | Original Presidio Analyzer sidecar detector. | Inject an authenticated internal `POST /analyze` endpoint. | [Guardrails](./guardrails.md) |
| `@purista/harness-guardrails-native-privacy` | Local Rust Node-API common-identifier detector. | `createNativePrivacyDetector({ id })`. | [Guardrails](./guardrails.md) |
| `@purista/harness-guardrails-local-ner` | Optional local Transformers.js NER detector. | Install optional peer, pin local assets and labels, call `warmup()`. | [Guardrails](./guardrails.md) |
| `@purista/harness-agent-plugins` | Reviewed, data-only Agent Plugins v1 skills and MCP bindings. | Inspect, persist the digest, explicitly trust, then bind selected components. | [Agent Plugins](./agent-plugins.md) |

Optional core peers are not packages in this catalogue: install
`@modelcontextprotocol/client` for MCP, `just-bash` for the exec-capable bash
sandbox, and `@opentelemetry/api` when connecting to application OpenTelemetry
context.

Provider adapters make outbound SDK calls from the application process.
Guardrails and native privacy run in process; Presidio calls only the supplied
internal endpoint; local NER reads only supplied local model assets. Agent
Plugins read local data-only manifests and never auto-expose components or
credentials. None of these packages replaces application authentication,
authorization, tenancy, transport, persistence, or incident controls.

For the full website catalogue with configuration examples and internal
documentation links, see the [AI Harness ecosystem guide](https://purista.dev/handbook/harness/guide/ecosystem-packages/).
