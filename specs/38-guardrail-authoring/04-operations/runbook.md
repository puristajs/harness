# Operational contract

Before serving: construct actions/providers/detectors, pass the inline policy to
`defineGuardrails`, attach definitions, and complete `.build()`. On invalid
configuration fail startup with the safe config error; correct the application
composition and rebuild. Do not accept traffic with missing/disabled required
rails.

No remote verification, health probe, model API call or detector call is
introduced by Harness preflight. Application provider factory side effects remain
caller-owned. There is no cache/watch/hot reload; a changed configuration creates
a new rail/Harness composition. Existing shutdown/session cleanup semantics
remain in force.

Release is a coordinated code deployment with breaking APIs. Publish is not
authorized by the plan. Rollback, if required by the application operator,
restores the previous whole code artifact; do not mix schemas or resume old
in-flight operations with new code. No data reset, migration command,
compatibility switch, feature flag, SBOM pipeline or signing service is added.
Existing dependency/license/release controls remain unchanged because the
unneeded dependency is removed.
