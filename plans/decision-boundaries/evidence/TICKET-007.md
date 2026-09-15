# TICKET-007 — application-owned durable review

Recorded implementation and independent review: 2026-08-26.

Replaced consumed state with strict immutable action/task/execution/receipt schemas, application authorization and CAS claims/receipts. The retry lookup returns an existing frozen task before validating a new candidate wait ID. Current action binding is checked outside replayed steps. Added recovery/strict-schema/receipt/concurrent-resume tests.

Cross-harness testing found two core lease hazards: non-atomic overwrite in in-memory createRun and losing-invocation finalization without an acquired binding. The coordinator authorized the bounded sessions/storage repair. Tests now cover an active owner and two synchronized first observers; exactly one handler runs and persisted input belongs to its lease winner.

Verification recorded: core build, example typecheck, 12 example tests, 134 focused durable/storage tests, and independent review passed. The four extra core paths are recorded in the ticket write scope. Final whole-tree verification remains required.
