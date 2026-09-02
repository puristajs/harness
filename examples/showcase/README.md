# Harness capability showcase

This example combines structured agents, a typed tool, a mounted skill,
workflow delegation, and an in-memory sandbox. Tests inject a deterministic
provider. The runnable application uses OpenAI.

Install and verify it from this directory:

```sh
npm install
npm run typecheck
npm test
npm run build
```

Set the provider key before starting the application:

```sh
export OPENAI_API_KEY=your-key
export OPENAI_MODEL=gpt-5-mini # optional
npm start
```

The application runs one incident-summary workflow and one policy question.
The policy agent calls the typed `policy_lookup` tool before returning its
structured answer.
