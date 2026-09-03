# Quickstart Example

This is the smallest runnable harness example. It defines one model alias, one
agent, and one workflow.

The workflow is intentionally small but shows the production shape:

- agents are registered before workflows so `ctx.agents.assistant` is typed;
- workflow code owns orchestration, metrics, and memory writes;
- the session API invokes `session.workflows.explain_quickstart.run(...)`;
- tests inject a fake model provider, so no API key is required for CI.

## Run

From this example directory:

```bash
npm install
cp .env.example .env
# set OPENAI_API_KEY in .env
npm test
npm run build
npm start
```

The example stores the last topic in session memory, records two application
metrics, invokes the assistant agent, and prints the validated answer.
