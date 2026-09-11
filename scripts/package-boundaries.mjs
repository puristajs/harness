import { dirname, resolve } from 'node:path'

// Spec 31 deliberately owns the detector port in the provider-neutral Guardrails
// addon. These are directed contract-owner edges, not an addon namespace waiver.
const detectorPackages = new Set([
  '@purista/harness-guardrails-local-ner',
  '@purista/harness-guardrails-native-privacy',
  '@purista/harness-guardrails-presidio'
])

export function verifyPackageBoundaries(manifests) {
  for (const manifest of manifests) {
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.peerDependencies,
      ...manifest.devDependencies,
      ...manifest.optionalDependencies
    }
    if (isHarnessPackage(manifest.name)) {
      const frameworkDependencies = Object.keys(dependencies).filter((name) => name.startsWith('@purista/') && !isHarnessPackage(name))
      if (frameworkDependencies.length > 0) {
        throw new Error(`${manifest.name} must not depend on PURISTA framework packages: ${frameworkDependencies.join(', ')}`)
      }
    }
    const harnessDependencies = Object.keys(dependencies).filter((name) => name === '@purista/harness' || name.startsWith('@purista/harness-'))
    if (manifest.name === '@purista/harness' && harnessDependencies.some((name) => name !== '@purista/harness')) {
      throw new Error('Core @purista/harness must not depend on a provider or adapter package.')
    }
    if (manifest.name !== '@purista/harness' && manifest.name.startsWith('@purista/harness-')) {
      const forbidden = harnessDependencies.filter((name) => name !== '@purista/harness'
        && name !== manifest.name
        && !(detectorPackages.has(manifest.name) && name === '@purista/harness-guardrails'))
      if (forbidden.length > 0) {
        throw new Error(`${manifest.name} must not depend on another provider or adapter package: ${forbidden.join(', ')}`)
      }
    }
  }
}

function isHarnessPackage(name) {
  return name === '@purista/harness' || name.startsWith('@purista/harness-')
}

/** Enforce published Core entrypoints for adapter and example source imports. */
export function verifyPublicHarnessImports(ts, path, content) {
  const normalized = path.replaceAll('\\', '/')
  const adapter = /(?:^|\/)packages\/harness-[^/]+\//.test(normalized)
  const decisionExample = /(?:^|\/)examples\/(?:guardrails|bank-governance|durable-human-review|opa-governance)\//.test(normalized)
  if (!adapter && !decisionExample) return []
  const testing = /(?:^|\/)(?:test|type-tests|testing|examples)\/|\.test\.[cm]?[jt]sx?$/.test(normalized)
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true)
  const findings = []
  const visit = node => {
    const specifier = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? node.moduleSpecifier
      : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) ? node.argument.literal
        : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require') ? node.arguments[0] : undefined
    if (specifier && ts.isStringLiteral(specifier)) {
      const name = specifier.text
      const relativeCore = name.startsWith('.') && /(?:^|\/)packages\/harness(?:\/|$)/.test(resolve(dirname(path), name).replaceAll('\\', '/'))
      const publicTestingEntry = name === '@purista/harness/testing' && testing
      const publicAdapterAuthorEntry = name === '@purista/harness/adapter' && adapter
      const privateSubpath = name.startsWith('@purista/harness/') && !publicTestingEntry && !publicAdapterAuthorEntry
      if (relativeCore || privateSubpath) findings.push({ path, line: source.getLineAndCharacterOfPosition(specifier.getStart(source)).line + 1, rule: 'private-import', symbol: name })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return findings
}
