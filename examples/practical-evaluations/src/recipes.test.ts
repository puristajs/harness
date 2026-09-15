import { describe, expect, it } from 'vitest'
import { classificationReport, runClassificationEvaluation } from './classification.js'
import { extractionReport, runExtractionEvaluation } from './extraction.js'
import { ragReport, runRagEvaluation } from './rag.js'
import { runSubagentAsToolEvaluation, subagentAsToolReport } from './subagent-as-tool.js'
import { runToolCallingAgentEvaluation, toolCallingAgentReport } from './tool-calling-agent.js'
import { runTranslationEvaluation, translationReport } from './translation.js'
import { rescoreWorkflowObservation, runWorkflowEvaluation, workflowReport } from './workflow.js'

describe('practical evaluation recipes', () => {
  it('evaluates classification and structured extraction offline', async () => {
    expect(classificationReport(await runClassificationEvaluation())).toEqual({ exactLabelRate: 1 })
    expect(extractionReport(await runExtractionEvaluation())).toEqual({ requiredFieldsRate: 1 })
  })

  it('keeps RAG grounding and provider accounting distinct', async () => {
    expect(ragReport(await runRagEvaluation())).toEqual({ groundingRate: 1, taskTokens: 16 })
  })

  it('uses an injected judge adapter and exposes only its aggregate cost', async () => {
    expect(translationReport(await runTranslationEvaluation())).toEqual({ acceptedRate: 1, judgeCostUsd: 0.00008 })
  })

  it('scores tool-use, sub-agent delegation, and workflow completion as domain behavior', async () => {
    expect(toolCallingAgentReport(await runToolCallingAgentEvaluation())).toEqual({ policyRate: 1 })
    expect(subagentAsToolReport(await runSubagentAsToolEvaluation())).toEqual({ coordinationRate: 1 })
    expect(workflowReport(await runWorkflowEvaluation())).toEqual({ completionRate: 1 })
  })

  it('re-scores a saved workflow observation without a task run', async () => {
    const result = await rescoreWorkflowObservation()
    expect(result.mode).toBe('score_only')
    expect(result.cases[0]?.task.status).toBe('not_run')
    expect(workflowReport(result)).toEqual({ completionRate: 1 })
  })
})
