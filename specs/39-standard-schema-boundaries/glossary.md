# Glossary

- **Standard Schema:** Structural V1 validation interface at `~standard.validate`; may be synchronous or asynchronous and may transform values.
- **Standard JSON Schema:** Orthogonal V1 interface at `~standard.jsonSchema` that projects input/output types to requested JSON Schema targets.
- **Schema:** Harness Standard Schema validation contract. Its raw input association stays vendor-exact; Harness requires its validated output to be JSON at each public value boundary.
- **ModelSchema:** Harness contract implementing both `Schema` and Standard JSON Schema; required only when Harness must describe model-produced input.
- **Input type:** Value accepted before validation (`InferIn`).
- **Output type:** Successful validated/transformed value (`Infer`).
- **Model-facing boundary:** Tool input or default-loop agent output supplied to a provider as JSON Schema.
- **Compiled definition:** Private build output containing original schemas and frozen projected JSON schemas.
- **Clean break:** Direct replacement with no legacy overload, alias, wrapper, deprecation or migration implementation.
