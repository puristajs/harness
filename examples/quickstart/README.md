# Quickstart Example

This is the smallest runnable Harness example. It defines one structured agent, adds it to a Harness, and binds a model provider when the application starts.

## Run it

```bash
npm install
cp .env.example .env
# set OPENAI_API_KEY in .env
npm test
npm run build
npm start
```

`defineAgent(...)` owns the input, output, prompt, and instructions. `defineHarness(...).addAgent(...)` keeps that definition independent of credentials. `getInstance({ model })` binds the OpenAI provider for the process. The test passes `FakeModelProvider`, so CI uses no network or API key.
