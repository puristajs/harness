// These are the intentional negative source references to removed v3 public names.
// Each directive proves that the package root no longer exports that API.
import type {
	AgentResponseMode,
	AnyHarnessTargetContract,
	HarnessExecutionCaller,
	HarnessInterruptForKinds,
	HarnessTargetDefinitionInference,
	HarnessTargetExecutionEvent,
	HarnessTargetInferenceFor,
	HarnessTargetInput,
	HarnessTargetOutput,
	HarnessUpdateFor,
	HarnessValidatedTargetInput,
	McpServerInference,
	NestedExecutionEvent,
	RootExecutionEventFor,
	SkillInference,
} from '../src/index.js'
// @ts-expect-error HarnessTargetInference is package-private in v4.
import type { HarnessTargetInference } from '../src/index.js'
// @ts-expect-error the invariant witness shape is package-private in v4.
import type { HarnessTargetInferenceShape } from '../src/index.js'
// @ts-expect-error HarnessTargetInference is absent from the definitions barrel too.
import type { HarnessTargetInference as DefinitionsHarnessTargetInference } from '../src/definitions/index.js'
// @ts-expect-error BuilderState was removed by the v4 clean break.
import type { BuilderState } from '../src/index.js'
// @ts-expect-error HarnessModule was removed by the v4 clean break.
import type { HarnessModule } from '../src/index.js'
// @ts-expect-error RunEvent was replaced by ExecutionEvent.
import type { RunEvent } from '../src/index.js'
// @ts-expect-error defineHarnessModule was removed by the v4 clean break.
import { defineHarnessModule } from '../src/index.js'
// @ts-expect-error HarnessBuilder was removed by the v4 clean break.
import type { HarnessBuilder } from '../src/index.js'
// @ts-expect-error HarnessModuleBuilder was removed by the v4 clean break.
import type { HarnessModuleBuilder } from '../src/index.js'
// @ts-expect-error evaluatePromptCandidates was removed by the evaluation clean break.
import { evaluatePromptCandidates } from '../src/index.js'
// @ts-expect-error PromptCandidate was removed by the evaluation clean break.
import type { PromptCandidate } from '../src/index.js'
// @ts-expect-error EvaluationItem was removed by the evaluation clean break.
import type { EvaluationItem } from '../src/index.js'
// @ts-expect-error CandidateScore was removed by the evaluation clean break.
import type { CandidateScore } from '../src/index.js'
// @ts-expect-error EvaluatePromptCandidatesInput was removed by the evaluation clean break.
import type { EvaluatePromptCandidatesInput } from '../src/index.js'
// @ts-expect-error evaluateDeterministicScorer was removed by the evaluation clean break.
import { evaluateDeterministicScorer } from '../src/index.js'
// @ts-expect-error DeterministicScorerDefinition was removed by the evaluation clean break.
import type { DeterministicScorerDefinition } from '../src/index.js'
// @ts-expect-error ScorerTarget was removed by the evaluation clean break.
import type { ScorerTarget } from '../src/index.js'
// @ts-expect-error ScorerResult was removed by the evaluation clean break.
import type { ScorerResult } from '../src/index.js'
// @ts-expect-error testing has no alternate Harness constructor.
import { makeHarness } from '../src/testing/index.js'

void (0 as unknown as BuilderState)
void (0 as unknown as HarnessModule)
void (0 as unknown as RunEvent)
void defineHarnessModule
void (0 as unknown as HarnessBuilder)
void (0 as unknown as HarnessModuleBuilder)
void evaluatePromptCandidates
void (0 as unknown as PromptCandidate)
void (0 as unknown as EvaluationItem)
void (0 as unknown as CandidateScore)
void (0 as unknown as EvaluatePromptCandidatesInput)
void evaluateDeterministicScorer
void (0 as unknown as DeterministicScorerDefinition)
void (0 as unknown as ScorerTarget)
void (0 as unknown as ScorerResult)
void makeHarness

type CurrentV4Surface = readonly [
	AgentResponseMode,
	AnyHarnessTargetContract,
	HarnessExecutionCaller,
	HarnessInterruptForKinds<readonly []>,
	HarnessTargetDefinitionInference<any>,
	HarnessTargetExecutionEvent<any>,
	HarnessTargetInferenceFor<string, string, string, 'text-delta', readonly []>,
	HarnessTargetInput<any>,
	HarnessTargetOutput<any>,
	HarnessUpdateFor<any, any>,
	HarnessValidatedTargetInput<any>,
	McpServerInference<any>,
	NestedExecutionEvent,
	RootExecutionEventFor<any>,
	SkillInference<readonly ['node']>,
]
void (0 as unknown as CurrentV4Surface)
void (0 as unknown as HarnessTargetInference)
void (0 as unknown as HarnessTargetInferenceShape)
void (0 as unknown as DefinitionsHarnessTargetInference)
