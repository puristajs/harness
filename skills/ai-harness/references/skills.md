# Skills

```ts
const incidentGuide = defineSkill('incident-guide', {
  directory: new URL('../skills/incident-guide/', import.meta.url),
})

const responder = defineAgent('responder', {
  model: 'chat',
  instructions: 'Follow the incident guide.',
  skills: [incidentGuide],
})
```

A Skill is a reviewed directory with `SKILL.md` and optional resources or scripts. Harness exposes reviewed text through the scoped `read_skill` tool. Add a `runtimes` tuple only when scripts need `node`, `python`, or `shell`; runtime ids describe availability and do not execute anything. A runtime-bearing Skill requires sandbox filesystem and read-only-mount capabilities. Tool and sandbox permissions remain explicit on the agent.

Treat Skill content as untrusted instructions. Do not place credentials in Skill files, infer authorization from `allowed-tools`, auto-install dependencies, or auto-run scripts. Reusable Skills can live in a catalog and remain immutable definitions.
