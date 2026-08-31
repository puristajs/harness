# Guardrails quickstart

This example protects one OpenAI-backed support agent with one deterministic
input rail. An ordinary request reaches the configured model. An
instruction-override request is blocked before the provider is called.

Install the application dependencies from this directory:

```bash title="Install the example application"
npm install
```

Copy the environment template and add an OpenAI API key:

```bash title="Configure the OpenAI provider"
cp .env.example .env
```

The `start` script uses Node's `--env-file-if-exists=.env` flag. You can
instead provide `OPENAI_API_KEY` and the optional `OPENAI_MODEL` through the
process environment.

```bash title="Verify and run the guarded agent"
npm run typecheck
npm test
npm run build
npm start
```

Expected output:

```text title="Allowed and blocked results"
allowed: <the provider's support answer>
blocked: instruction_override
```

The tests inject `FakeModelProvider`, so `npm test` needs no API key or network
access. They prove the Guardrail execution path and that a blocked request does
not reach the provider. They do not measure the quality of the live model or
the phrase detector.
