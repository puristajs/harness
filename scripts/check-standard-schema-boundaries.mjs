import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url))
const defaultRoot = existsSync(join(workspaceRoot, 'ai-harness')) ? workspaceRoot : repositoryRoot
export const publicBoundaryOwners = [
  { path: 'ai-harness/packages/harness/src/harness/defineHarness.ts', rules: ['legacy-zod-generic', 'legacy-zod-infer', 'direct-user-schema-parser', 'runtime-zod-json-schema', 'validator-json-cast', 'compatibility-path', 'placeholder-conformance'] },
  { path: 'ai-harness/packages/harness/src/agents/index.ts', rules: ['legacy-zod-infer', 'direct-user-schema-parser', 'runtime-zod-json-schema', 'validator-json-cast', 'compatibility-path', 'placeholder-conformance'] },
  { path: 'ai-harness/packages/harness/src/agents/tool-execution.ts', rules: ['legacy-zod-infer', 'direct-user-schema-parser', 'runtime-zod-json-schema', 'validator-json-cast', 'compatibility-path', 'placeholder-conformance'] },
  { path: 'ai-harness/packages/harness/src/workflows/index.ts', rules: ['legacy-zod-infer', 'direct-user-schema-parser', 'runtime-zod-json-schema', 'validator-json-cast', 'compatibility-path', 'placeholder-conformance'] },
  { path: 'ai-harness/packages/harness/src/sessions/index.ts', rules: ['legacy-zod-infer', 'direct-user-schema-parser', 'runtime-zod-json-schema', 'validator-json-cast', 'compatibility-path', 'placeholder-conformance'] },
  { path: 'ai-harness/packages/harness-guardrails/src/action.ts', rules: ['legacy-zod-generic', 'legacy-zod-infer', 'direct-user-schema-parser', 'runtime-zod-json-schema', 'validator-json-cast', 'compatibility-path', 'placeholder-conformance'] },
  { path: 'ai-harness/packages/harness-guardrails/src/rails.ts', rules: ['legacy-zod-generic', 'legacy-zod-infer', 'direct-user-schema-parser', 'compatibility-path', 'placeholder-conformance'] },
  { path: 'ai-harness/packages/harness-guardrails/src/sensitive-data.ts', rules: ['legacy-zod-generic', 'legacy-zod-infer', 'direct-user-schema-parser', 'runtime-zod-json-schema', 'validator-json-cast', 'compatibility-path', 'placeholder-conformance'] },
  { path: 'ai-harness/packages/harness/src/schema/schema.test.ts', rules: ['skipped-conformance'] }
]

function resolveBoundaryOwner(root, ownerPath) {
  if (existsSync(join(root, 'ai-harness'))) return join(root, ownerPath)
  return join(root, ownerPath.replace(/^ai-harness\//, ''))
}

/** Returns the exact public-schema coupling patterns that the clean break forbids. */
export function findForbiddenStandardSchemaPatterns(content) {
  const rules = [
    ['legacy-zod-generic', /\bz\.Zod[A-Za-z0-9_]*\b/g],
    ['legacy-zod-infer', /\bz\.(?:input|output)\s*</g],
    ['direct-user-schema-parser', /\b(?:schema|inputSchema|outputSchema|valueSchema)\.(?:parse|safeParse)\s*\(/g],
    ['runtime-zod-json-schema', /\bz\.toJSONSchema\s*\(/g],
    ['validator-json-cast', /\b(?:schema|inputSchema|outputSchema|valueSchema)\s+as\s+(?:JsonValue|(?:Model|Provider|Json)Schema)\b/g],
    ['compatibility-path', /\b(?:legacySchema|compatibilitySchema|zodCompatibility|schemaVendorSwitch)\b/gi],
    ['placeholder-conformance', /\b(?:TODO|FIXME)\b[^\n]*(?:standard schema|schema conformance|cross-vendor)/gi],
    ['skipped-conformance', /\b(?:it|test|describe)\.skip\s*\([^\n]*(?:standard schema|schema conformance|cross-vendor)/gi]
  ]
  const findings = []
  for (const [rule, pattern] of rules) {
    for (const match of content.matchAll(pattern)) {
      findings.push({
        rule,
        line: content.slice(0, match.index).split('\n').length,
        match: match[0]
      })
    }
  }
  return findings
}

/** Checks only public user-schema boundary owners; internal configuration Zod remains deliberately out of scope. */
export async function checkStandardSchemaBoundaries(root = defaultRoot) {
  const findings = []
  for (const owner of publicBoundaryOwners) {
    const file = resolveBoundaryOwner(root, owner.path)
    if (!existsSync(file)) {
      findings.push({ path: owner.path, line: 1, rule: 'missing-public-boundary-owner', match: owner.path })
      continue
    }
    const content = await readFile(file, 'utf8')
    for (const finding of findForbiddenStandardSchemaPatterns(content)) {
      if (owner.rules.includes(finding.rule)) findings.push({ path: owner.path, ...finding })
    }
  }
  return findings.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line || left.rule.localeCompare(right.rule))
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const root = process.argv[2] ? resolve(process.argv[2]) : defaultRoot
  const findings = await checkStandardSchemaBoundaries(root)
  if (findings.length) {
    for (const finding of findings) process.stderr.write(`${finding.path}:${finding.line} ${finding.rule}: ${finding.match}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write('standard-schema boundary check ok\n')
  }
}
