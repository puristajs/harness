import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import {
  assertLocalResolution,
  createCompilerConfig,
  runCommand,
  scanRemovedSymbols,
  verifyConsumers,
} from './verify-decision-consumers.mjs';

const root = fileURLToPath(new URL('../.artifacts/decision-consumers/', import.meta.url));
await mkdir(root, { recursive: true });
const fixtureRoot = await mkdtemp(join(root, 'fixtures-'));
const ts = createRequire(import.meta.url)('typescript');
after(() => rm(fixtureRoot, { recursive: true, force: true }));

async function put(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return path;
}

test('exact local aliases resolve the current source instead of an installed registry copy', async () => {
  const repo = join(fixtureRoot, 'resolution');
  const local = await put(join(repo, 'packages/harness/src/index.ts'), 'export type Current = true;');
  const installed = await put(join(repo, 'node_modules/@purista/harness/index.d.ts'), 'export type Old = true;');
  const consumer = await put(join(repo, 'consumer.ts'), '');
  const options = { moduleResolution: ts.ModuleResolutionKind.Bundler, paths: { '@purista/harness': [local] } };
  assert.deepEqual(assertLocalResolution(ts, options, consumer, { '@purista/harness': local }), {
    '@purista/harness': local,
  });
  assert.throws(
    () => assertLocalResolution(ts, { ...options, paths: {} }, consumer, { '@purista/harness': local }),
    error => error.message.includes(installed) && error.message.includes(local),
  );
});

test('generated configs preserve existing aliases and confine build metadata', async () => {
  const repo = join(fixtureRoot, 'config');
  const original = await put(join(repo, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      incremental: true, composite: true, tsBuildInfoFile: '../forbidden.tsbuildinfo',
      paths: { '@other/*': ['./other/*'], '@purista/harness': ['./old.ts'] },
    },
  }));
  const output = join(repo, 'ai-harness/.artifacts/decision-consumers');
  const local = join(repo, 'harness.ts');
  const config = createCompilerConfig(ts, original, output, 'consumer', { '@purista/harness': local }, [local]);
  assert.equal(config.extends, original);
  assert.deepEqual(config.compilerOptions.paths['@other/*'], [join(repo, 'other/*')]);
  assert.deepEqual(config.compilerOptions.paths['@purista/harness'], [local]);
  assert.equal(config.compilerOptions.incremental, false);
  assert.equal(config.compilerOptions.composite, false);
  assert.equal(config.compilerOptions.noEmit, true);
  assert.equal(config.compilerOptions.tsBuildInfoFile, join(output, 'consumer.tsbuildinfo'));
  assert.equal(config.compilerOptions.outDir, join(output, 'consumer-output'));
  const smoke = createCompilerConfig(ts, original, output, 'declarations', {}, [local], { declarations: true });
  assert.equal(smoke.compilerOptions.skipLibCheck, false);
});

test('child failures retain diagnostics and propagate the actual exit status', async () => {
  const log = join(fixtureRoot, 'failure.log');
  await assert.rejects(
    runCommand(process.execPath, ['-e', "process.stderr.write('fixture failure'); process.exit(7)"], {
      cwd: fixtureRoot, log,
    }),
    error => error.exitCode === 7 && error.message.includes('fixture failure'),
  );
  assert.match(await readFile(log, 'utf8'), /fixture failure/);
});

test('removed API scanner checks source identifiers and permission ask without matching business prose', async () => {
  const repo = join(fixtureRoot, 'scan');
  await put(join(repo, 'starter/templates/agent.ts'), "const permissions = { bash: 'ask' }; const onPermission = () => true;");
  await put(join(repo, 'create-purista/src/valid.ts'), "const question = 'ask'; const approval = { consumed: true }; // onPermission\n");
  await put(join(repo, 'voyage/apps/server/src/invalid.ts'), "const onPermission = true; const permissions = { write: 'ask' };");
  await put(join(repo, 'starter/node_modules/old.ts'), 'type ProviderItems = string;');
  await put(join(repo, 'voyage/docs/business.md'), 'Ask for approval; onPermission is prose.');
  const findings = await scanRemovedSymbols(ts, repo);
  assert.equal(findings.length, 2);
  assert.ok(findings.some(finding => finding.symbol === 'onPermission'));
  assert.ok(findings.some(finding => finding.symbol === 'permissions.ask'));
});

test('removed API scanner catches quoted keys and typed permission declarations', async () => {
  const repo = join(fixtureRoot, 'quoted-scan');
  await mkdir(join(repo, 'create-purista'), { recursive: true });
  await put(join(repo, 'starter/agent.ts'), `
const configuration = { "onPermission": () => true };
const policy: PermissionPolicy = { mode: 'ask' };
const selected: AgentPermissions = { bash: 'ask' };
`);
  assert.deepEqual((await scanRemovedSymbols(ts, repo)).map(finding => finding.symbol), [
    'onPermission', 'permissions.ask', 'permissions.ask',
  ]);
});

test('missing consumer sources cannot be reported as an empty removed-API scan', async () => {
  for (const missing of ['starter', 'create-purista']) {
    const repo = join(fixtureRoot, `missing-${missing}`);
    await mkdir(join(repo, missing === 'starter' ? 'create-purista' : 'starter'), { recursive: true });
    await assert.rejects(scanRemovedSymbols(ts, repo), error => error.message.includes(`Missing required consumer source directory: ${join(repo, missing)}`));
  }
});

test('cleanup roots reuse the scanner for documentation and computed or destructured API names', async () => {
  const repo = join(fixtureRoot, 'cleanup-scan');
  await put(join(repo, 'src/api.ts'), `const { 'onPermission': handler } = api; api['providerItems'];
type PermissionMode = 'allow' | 'ask';
const mode = 'ask' satisfies PermissionMode;
permissions.write = 'ask';`);
  await put(join(repo, 'docs/guide.md'), 'Use `OnPermission` here.\n```ts\nconst permissions = { write: "ask" };\n```\nAsk an unrelated question.');
  const findings = await scanRemovedSymbols(ts, repo, { roots: ['src', 'docs'], documentation: true });
  for (const symbol of ['onPermission', 'providerItems', 'OnPermission']) assert.ok(findings.some(item => item.symbol === symbol));
  assert.equal(findings.filter(item => item.symbol === 'permissions.ask').length, 4);
});

test('removed inventory and qualified permission types cannot regress through aliases', async () => {
  const repo = join(fixtureRoot, 'inventory-scan');
  await put(join(repo, 'source.ts'), `import { onPermission, OnPermission, PermissionContext, PermissionDecision,
GovernanceRiskLevel, GovernanceAuditContext, AgentInterceptorError, PolicyEvaluationError,
GuardrailBlockedError, GuardrailEvaluationError, ProviderItems, providerItems, consumeApproved } from 'old';
const policy: Readonly<Harness.AgentPermissions> = { write: 'ask' };
definition.permissions . write = 'ask';`);
  const findings = await scanRemovedSymbols(ts, repo, { roots: ['source.ts'] });
  assert.equal(findings.filter(item => item.symbol !== 'permissions.ask').length, 13);
  assert.equal(findings.filter(item => item.symbol === 'permissions.ask').length, 2);
});

test('explicit negative fixture comments exclude only one statement in allowlisted test files', async () => {
  const repo = join(fixtureRoot, 'negative-scan');
  const code = '// @ts-expect-error decision-boundaries: removed API\nimport type { OnPermission } from "@purista/harness";\nconst onPermission = true;\n';
  await put(join(repo, 'type-tests/types.ts'), code);
  await put(join(repo, 'src/runtime.ts'), code);
  const findings = await scanRemovedSymbols(ts, repo, { roots: ['type-tests', 'src'], negativeFixtureFiles: ['type-tests/types.ts'] });
  assert.equal(findings.filter(item => item.symbol === 'OnPermission').length, 1);
  assert.equal(findings.filter(item => item.symbol === 'onPermission').length, 2);
  await assert.rejects(scanRemovedSymbols(ts, repo, { roots: ['src'], negativeFixtureFiles: ['src/runtime.ts'] }), /test file/);
  await put(join(repo, 'test/no-suite-exclusion.test.ts'), "// decision-boundaries: negative fixture\nit('must still scan the test', () => { const onPermission = true });\n");
  assert.equal((await scanRemovedSymbols(ts, repo, { roots: ['test'], negativeFixtureFiles: ['test/no-suite-exclusion.test.ts'] })).length, 1);
});

test('documentation held in a TypeScript template is scanned without treating unrelated strings as APIs', async () => {
  const repo = join(fixtureRoot, 'template-scan');
  const body = 'Use ProviderItems.\n```ts\nconst permissions = {write: "ask"};\n```\n';
  await put(join(repo, 'page.ts'), 'const page = { body: `' + body.replaceAll('`', '\\`') + '` }; const unrelated = "ProviderItems is historical prose";');
  const findings = await scanRemovedSymbols(ts, repo, { roots: ['page.ts'], documentation: true });
  assert.deepEqual(findings.map(item => item.symbol), ['ProviderItems', 'permissions.ask']);
});

test('a missing local dependency is a failure with retained diagnostics, never a skipped verification', async () => {
  const repo = join(fixtureRoot, 'missing-dependencies');
  await mkdir(join(repo, 'ai-harness'), { recursive: true });
  await assert.rejects(verifyConsumers(repo), /Missing installed local TypeScript/);
  const diagnostic = await readFile(join(repo, 'ai-harness/.artifacts/decision-consumers/diagnostics.json'), 'utf8');
  assert.match(diagnostic, /Missing installed local TypeScript/);
});

for (const voyage of ['absent', 'malformed']) test(`successful orchestration ignores ${voyage} Voyage and cleans only its artifact directory`, async () => {
  const repo = join(fixtureRoot, `successful-workspace-${voyage}`);
  await mkdir(join(repo, 'starter'), { recursive: true });
  await mkdir(join(repo, 'create-purista'), { recursive: true });
  const require = createRequire(import.meta.url);
  const config = JSON.stringify({ compilerOptions: { strict: true, module: 'ESNext', moduleResolution: 'Bundler', target: 'ES2022', types: [] } });
  for (const name of ['ai-harness', 'purista']) {
    await put(join(repo, name, 'node_modules/typescript/lib/tsc.js'), `require(${JSON.stringify(require.resolve('typescript/lib/tsc.js'))});`);
  }
  await put(join(repo, 'ai-harness/node_modules/typescript/lib/typescript.js'), `module.exports = require(${JSON.stringify(require.resolve('typescript'))});`);
  // This fixture tests orchestration/cleanup only. Real Core suites are run by the production checker.
  await put(join(repo, 'purista/node_modules/vitest/vitest.mjs'), 'process.exit(0);');
  await put(join(repo, 'purista/vitest.config.unit.ts'), 'export default {};');
  await put(join(repo, 'purista/packages/core/tsconfig.json'), config);
  await put(join(repo, 'ai-harness/packages/harness/tsconfig.json'), config);
  await put(join(repo, 'purista/packages/core/src/index.ts'), 'export const current = true;');
  await put(join(repo, 'purista/packages/core/src/HarnessMount/consumer.ts'), "import { current } from '@purista/core'; void current;");
  const excluded = "const onPermission = true; const permissions = { write: 'ask' }; const invalid: string = 42;";
  if (voyage === 'malformed') {
    await put(join(repo, 'voyage/apps/server/tsconfig.json'), '{invalid');
    await put(join(repo, 'voyage/apps/server/src/consumer.ts'), excluded);
    await put(join(repo, 'voyage/docs/purista-core-harness-migration.md'), 'OnPermission');
    await put(join(repo, 'voyage/node_modules/typescript/lib/tsc.js'), 'throw new Error("Voyage compiler must not run");');
  }
  const entries = {
    harness: `export function createDecisionEvidence(): void;
export class DecisionBlockedError {} export class DecisionEvaluationError {}
export function defineHarness(): void;
export type AgentPermissions = { write?: 'allow' | 'require_approval' | 'deny' };
export type GovernanceAuditRecord = { evidence: unknown };
export type ToolApprovalInterrupt = { type: 'tool-approval'; id: string; revision: string; requests: unknown[] };
export type ToolApprovalResume = { type: 'tool-approval'; runId: string; interruptId: string; revision: string; eventId: string; decisions: { approvalId: string; approved: boolean }[] };
export type ExternalWaitOutcome = 'approved' | 'rejected' | 'expired' | 'cancelled';
export type ProviderContinuation = { providerId: string; items: { kind: 'assistant_content' }[] };`,
    'harness-guardrails': "export function defineGuardrails(): void; export type GuardrailOutcome = { decision: 'allow' | 'block' }; export type GuardrailsConfig = { rails: {} };",
    'harness-openai': 'export function openai(): void;',
  };
  for (const [name, declaration] of Object.entries(entries)) {
    await put(join(repo, 'ai-harness/packages', name, 'src/index.ts'), declaration);
    await put(join(repo, 'ai-harness/packages', name, 'dist/index.d.ts'), declaration);
  }
  await put(join(repo, 'ai-harness/packages/harness/src/testing/index.ts'), 'export class FakeModelProvider {}');
  await put(join(repo, 'ai-harness/packages/harness/dist/testing/index.d.ts'), 'export class FakeModelProvider {}');
  await put(join(repo, 'ai-harness/packages/harness/dist/index.js'), 'export function createDecisionEvidence() {} export class DecisionBlockedError {} export class DecisionEvaluationError {}');
  await put(join(repo, 'ai-harness/packages/harness/dist/testing/index.js'), 'export class FakeModelProvider {}');
  await put(join(repo, 'ai-harness/packages/harness-guardrails/dist/index.js'), 'export function defineGuardrails() {}');
  await put(join(repo, 'ai-harness/packages/harness-openai/dist/index.js'), 'export function openai() {}');
  const sentinel = await put(join(repo, 'ai-harness/.artifacts/unrelated.txt'), 'preserve');
  // All source entries precede this final core declaration, as in an actual fresh build.
  await put(join(repo, 'ai-harness/packages/harness/dist/index.d.ts'), entries.harness);
  const result = await verifyConsumers(repo);
  assert.deepEqual(result.checks.map(check => check.name), [
    'core source', 'Core runtime tests', 'built package declarations',
    'built package runtime imports', 'Starter/create-purista removed APIs',
  ]);
  assert.ok(result.checks.every(check => check.status === 'passed'));
  await assert.rejects(access(join(repo, 'ai-harness/.artifacts/decision-consumers')), { code: 'ENOENT' });
  assert.equal(await readFile(sentinel, 'utf8'), 'preserve');
  assert.equal(await readFile(join(repo, 'purista/packages/core/src/HarnessMount/consumer.ts'), 'utf8'), "import { current } from '@purista/core'; void current;");
  if (voyage === 'malformed') assert.equal(await readFile(join(repo, 'voyage/apps/server/src/consumer.ts'), 'utf8'), excluded);
  else await assert.rejects(access(join(repo, 'voyage')), { code: 'ENOENT' });
});
