import { classificationReport, runClassificationEvaluation } from './classification.js'
import { extractionReport, runExtractionEvaluation } from './extraction.js'
import { ragReport, runRagEvaluation } from './rag.js'
import { runSubagentAsToolEvaluation, subagentAsToolReport } from './subagent-as-tool.js'
import { runToolCallingAgentEvaluation, toolCallingAgentReport } from './tool-calling-agent.js'
import { runTranslationEvaluation, translationReport } from './translation.js'
import { rescoreWorkflowObservation, runWorkflowEvaluation, workflowReport } from './workflow.js'

async function main(): Promise<void> {
  console.log({
    classification: classificationReport(await runClassificationEvaluation()),
    extraction: extractionReport(await runExtractionEvaluation()),
    rag: ragReport(await runRagEvaluation()),
    translation: translationReport(await runTranslationEvaluation()),
    toolCallingAgent: toolCallingAgentReport(await runToolCallingAgentEvaluation()),
    subagentAsTool: subagentAsToolReport(await runSubagentAsToolEvaluation()),
    workflow: workflowReport(await runWorkflowEvaluation()),
    workflowRescore: workflowReport(await rescoreWorkflowObservation())
  })
}

void main()
