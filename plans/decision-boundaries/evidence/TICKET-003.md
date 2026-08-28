# TICKET-003 — provider continuation

Recorded implementation and independent review: 2026-08-26.

Replaced ProviderItems with strict ProviderContinuation across core and OpenAI. OpenAI reconstructs current canonical calls/arguments and ordered opaque reasoning; foreign continuations use canonical messages. Review repaired validation that previously ran only for nonempty own templates.

Verification recorded: OpenAI 49 tests, Anthropic 23, Bedrock 26, Azure 20, focused core tests 28; core build/typecheck/type tests and all provider typechecks passed. Tests explicitly reject malformed own envelopes, unknown/duplicate/missing tool slots and multiple content slots before I/O, including stream entrypoints. Independent re-review passed.

Final whole-tree verification remains TICKET-010's responsibility.
