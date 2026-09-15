/**
 * AI SDK UI Message Stream v1 adapter for native Harness execution events.
 *
 * Version-specific protocol code lives behind the `./v1` entry point so a
 * later wire protocol can be added without changing existing consumers.
 */
export * from './v1/index.js'
