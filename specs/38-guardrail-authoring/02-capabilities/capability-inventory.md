# Capability inventory

Actors are application developers, package maintainers and deployment operators. SDK/CI/documentation capabilities are in scope. Admin UI, worker/job service and durable-data capabilities are absent by scoped applicability.

| ID | Outcome | Owner | Entry | Contract |
| --- | --- | --- | --- | --- |
| CAP-GA-CALLBACKS | Schema-directed native tools and callback inference | core | builder/helper API | CTR-GA-CALLBACKS |
| CAP-GA-CONFIG | One inline configuration schema and clean removal of file configuration | addon and consumers | public addon API | CTR-GA-CONFIG, CTR-GA-GENERATION, CTR-GA-ERRORS |
| CAP-GA-REQUIREMENTS | Provider-neutral interceptor build preflight | core | builder/helper API | CTR-GA-BINDING, CTR-GA-ERRORS |
| CAP-GA-ACTIONS | Sound action tokens and schema-bound sensitive codecs | addon and consumers | public addon API or existing docs/CI scripts | CTR-GA-ACTIONS, CTR-GA-CONFIG, CTR-GA-ERRORS |
| CAP-GA-BINDING | Attach requirements and end-to-end deployment preflight | addon and consumers | public addon API or existing docs/CI scripts | CTR-GA-BINDING, CTR-GA-ACTIONS, CTR-GA-DOCS |
| CAP-GA-DOCS | Harness guides, examples and canonical skill alignment | addon and consumers | public addon API or existing docs/CI scripts | CTR-GA-DOCS, CTR-GA-CLEANUP |
| CAP-GA-WEBSITE | PURISTA handbook, phase projections and skill reuse | addon and consumers | public addon API or existing docs/CI scripts | CTR-GA-DOCS, CTR-GA-CLEANUP |
| CAP-GA-CLEANUP | Consumer cut, CI drift gates and final acceptance | addon and consumers | public addon API or existing docs/CI scripts | CTR-GA-CLEANUP, CTR-GA-GENERATION |
