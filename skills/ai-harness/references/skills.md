# Skills

```ts
const incidentGuide = defineSkill('incident-guide', {
  directory: new URL('../skills/incident-guide/', import.meta.url),
  runtimes: ['node'],
})

const responder = defineAgent('responder', {
  instructions: 'Follow the incident guide.',
  skills: [incidentGuide],
})
```

A Skill is a reviewed directory with `SKILL.md` and optional resources or scripts. Runtime ids describe what its scripts require; they do not execute anything. The sandbox must provide the capabilities needed to mount and use the Skill. Tool and sandbox permissions remain explicit on the agent.

Treat Skill content as untrusted instructions. Do not place credentials in Skill files, infer authorization from `allowed-tools`, auto-install dependencies, or auto-run scripts. Reusable Skills can live in a catalog and remain immutable definitions.
