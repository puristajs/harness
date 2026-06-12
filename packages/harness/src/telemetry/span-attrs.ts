import type { JsonValue } from '../models/json.js'

/**
 * Converts caller-supplied invoke metadata into namespaced span attributes.
 *
 * Only scalar values survive: strings up to 256 chars, finite numbers, and
 * booleans. Keys must look like attribute identifiers; everything else is
 * dropped so unvetted metadata can never grow spans without bound.
 */
export function metadataSpanAttrs(metadata: Readonly<Record<string, JsonValue>> | undefined): Record<string, string | number | boolean | undefined> {
  const attrs: Record<string, string | number | boolean | undefined> = {}
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(key)) continue
    if (typeof value === 'string') {
      if (value.length <= 256) attrs[`harness.metadata.${key}`] = value
      continue
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      attrs[`harness.metadata.${key}`] = value
      continue
    }
    if (typeof value === 'boolean') {
      attrs[`harness.metadata.${key}`] = value
    }
  }
  return attrs
}
