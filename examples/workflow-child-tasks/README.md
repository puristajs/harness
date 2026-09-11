# Workflow Child Tasks

A runnable, credential-free example of three orchestration patterns:

- return a workflow-owned background review task id, then retrieve its typed
  result with `session.childTasks.get(id)`;
- bound short parallel work with `ctx.fanOut` when you need ordered results;
- keep a short, private task conversation alive with
  `{ mode: 'continuable' }`, `send(...)`, and `close()`.

```bash
npm install
npm run test
npm run start
```

The two agents use the normal bounded model loop with `FakeModelProvider`, so this example needs no provider credential. The same task ownership, delegation policy, isolation, and lifecycle API applies with a production provider.
Continuable tasks are in-process only; use an application queue/worker for work
that must survive a process restart.
