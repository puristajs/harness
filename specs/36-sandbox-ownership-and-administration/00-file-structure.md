# Source placement

Use domain-local modules under existing packages, not a new package tree.
Public ownership/administration contracts belong beside sandbox/index.ts;
private policy resolution belongs under sessions; workspace checkpoint coordination
belongs under runtime/local; Docker retains its independent package. Framework
mapping remains within AgentQueueBuilder and service AI configuration.

The exact bounded write scopes are ticket-owned. See 04-delivery.md for mandatory
module locations and no-duplication rules. Generated declarations/docs follow the
existing compiler/TypeDoc outputs and are never handwritten.
