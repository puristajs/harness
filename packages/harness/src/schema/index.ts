import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec'
import type { JsonValue } from '../models/json.js'

export type JsonSchemaValue = null | boolean | number | string | undefined | readonly JsonSchemaValue[] | { readonly [key: string]: JsonSchemaValue }

/**
 * A Standard Schema validator whose accepted input and validated output are
 * determined by the validator.
 *
 * Use this at every Harness validation boundary. Zod is the default in the
 * documentation, but any compatible validator can satisfy this structural
 * contract.
 *
 * @example
 * ```ts
 * import { z } from 'zod'
 * import type { Schema } from '@purista/harness'
 *
 * const input: Schema = z.object({ ticketId: z.string() })
 * ```
 *
 * @example
 * ```ts
 * import { type } from 'arktype'
 *
 * const input = type({ ticketId: 'string' })
 * ```
 */
export type Schema<Input extends JsonSchemaValue = JsonSchemaValue, Output extends JsonSchemaValue = JsonSchemaValue> = StandardSchemaV1<Input, Output>

/**
 * A Standard Schema validator that can also produce JSON Schema for
 * model-generated values.
 *
 * TypeScript tool inputs and default-loop agent outputs require this narrower
 * contract. Validation-only boundaries accept {@link Schema} instead.
 */
export type ModelSchema<Input extends JsonSchemaValue = JsonSchemaValue, Output extends JsonSchemaValue = JsonSchemaValue> =
  StandardSchemaV1<Input, Output> & StandardJSONSchemaV1<Input, Output>

/** Infers the validated output of a {@link Schema}. */
export type Infer<S extends StandardSchemaV1> = StandardSchemaV1.InferOutput<S>

/** Infers the value a caller or handler may provide to a {@link Schema}. */
export type InferIn<S extends StandardSchemaV1> = StandardSchemaV1.InferInput<S>

/** Factory-only proof that both Standard Schema sides are JSON roots. */
export type JsonSchemaBoundary<S extends StandardSchemaV1> =
	undefined extends InferIn<S> ? never
		: undefined extends Infer<S> ? never
			: InferIn<S> extends JsonSchemaValue
				? Infer<S> extends JsonSchemaValue ? S : never
				: never
