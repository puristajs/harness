# Jaeger Notes Source

Local tracing uses Jaeger 2.17 with OTLP ports exposed on `4317` and `4318`.
The example service name is `purista-living-wiki-example`, and missing Jaeger
must not block local app usage.

Useful manual check:

```bash
npm run jaeger
```

Seed references: [[jaeger-tracing]], [[workflow-observation]].
