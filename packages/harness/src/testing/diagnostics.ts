import type { HarnessInspection } from '../ports/capabilities.js'

/** Content-free diagnostic finding returned by an explicit test invariant. */
export interface HarnessDiagnosticFinding { readonly path: string; readonly message: string }
/** Data-minimized completed configuration/run snapshot for test invariants. */
export interface DiagnosticInvariantSnapshot {
  readonly inspection: HarnessInspection
  readonly events?: readonly { readonly ordinal: number; readonly type: string; readonly runId?: string; readonly agentId?: string; readonly toolId?: string; readonly callId?: string; readonly attempt?: number }[]
}
/** Explicit synchronous development-only diagnostic check. */
export interface HarnessDiagnosticInvariant { readonly id: string; check(snapshot: DiagnosticInvariantSnapshot): HarnessDiagnosticFinding | undefined }
/** Thrown only by {@link assertDiagnosticInvariants}. */
export class DiagnosticInvariantError extends Error {
  public readonly code = 'DIAGNOSTIC_INVARIANT_ERROR'
  public constructor(public readonly meta: { invariantId: string; path: string }, message: string) { super(message); this.name = 'DiagnosticInvariantError' }
}
/** Executes test invariants in order and throws the first content-free finding. */
export function assertDiagnosticInvariants(snapshot: DiagnosticInvariantSnapshot, invariants: readonly HarnessDiagnosticInvariant[]): void {
  for (const invariant of invariants) {
    const finding = invariant.check(snapshot)
    if (finding) throw new DiagnosticInvariantError({ invariantId: invariant.id, path: finding.path }, finding.message)
  }
}
