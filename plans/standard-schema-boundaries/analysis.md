# Analysis

The provider limitation is not a blocker. Core provider ports already accept plain `JsonValue` JSON Schema and every first-party adapter forwards that shape; none requires a Zod object. The real coupling is earlier: public builder generics, runtime `.parse` calls, and direct Zod conversion.

Standard Schema validation and Standard JSON Schema projection are orthogonal. Therefore the sound minimal design is `Schema` for every validation boundary and `ModelSchema` (both standards) only for tool input and default-loop output. The original schema remains authoritative for local validation; the Draft 2020-12 input projection is compiled once at build and forwarded unchanged.

The clean break is intentional. Public Zod constraints and casts are deleted; internal Zod configuration/state/built-in schemas remain because removing them would add complexity without user value. Exact type directions, errors, JSON invariants, vendor versions, provider policy and consumer scope are frozen in `../../specs/39-standard-schema-boundaries`.

Confirmed source defect: memory summarization casts a Zod object into `ObjectRequest.schema`; TICKET-003 must replace it with real JSON Schema and a regression test.
