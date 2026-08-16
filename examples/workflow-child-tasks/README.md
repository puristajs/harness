# Workflow Child Tasks

A runnable, credential-free example of three orchestration patterns:

- return a workflow-owned background review task id, then retrieve its typed
  result with `session.childTasks.get(id)`;
- bound short parallel work with `ctx.fanOut` when you need ordered results;
- keep a short, private task conversation alive with
  `{ mode: 'continuable' }`, `send(...)`, and `close()`.

```bash
npm run test --workspace @purista/workflow-child-tasks-example
npm run start --workspace @purista/workflow-child-tasks-example
```

The two agents use deterministic handlers solely so this example has no model
provider credential. Replacing them with normal model-loop agents preserves the
same task ownership, delegation policy, sandbox isolation, and lifecycle API.
Continuable tasks are in-process only; use an application queue/worker for work
that must survive a process restart.
