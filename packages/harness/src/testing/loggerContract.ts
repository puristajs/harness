import { describe, expect, it } from 'vitest'

import type { Logger, LogLevel } from '../logger/index.js'

const LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal']

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

type CapturedRecord = { level?: unknown; msg?: unknown; time?: unknown; bindings?: unknown }

function capturedRecords(logger: Logger): CapturedRecord[] | undefined {
  const records = (logger as { records?: unknown }).records
  return Array.isArray(records) ? (records as CapturedRecord[]) : undefined
}

/**
 * Shared contract for `Logger` implementations.
 *
 * Record-shape assertions require a capturing logger that exposes its emitted
 * records via a `records` array (e.g. `FakeLogger`); non-capturing loggers are
 * verified for the behavioral contract only.
 */
export function loggerContract(make: () => Logger): void {
  describe('loggerContract', () => {
    it('exposes every level method and none of them throw', () => {
      const logger = make()
      for (const level of LEVELS) {
        expect(typeof logger[level]).toBe('function')
        expect(() => logger[level](`${level} message`, { level })).not.toThrow()
      }
    })

    it('child(bindings) returns a logger with the full level surface', () => {
      const logger = make()
      const child = logger.child({ component: 'contract' })
      for (const level of LEVELS) {
        expect(typeof child[level]).toBe('function')
      }
      expect(() => child.info('child message')).not.toThrow()
    })

    it('emits one record per level with an RFC3339 time when records are capturable', () => {
      const logger = make()
      const records = capturedRecords(logger)
      if (!records) return
      records.length = 0
      for (const level of LEVELS) {
        logger[level](`${level} message`)
      }
      expect(records).toHaveLength(LEVELS.length)
      for (const [index, level] of LEVELS.entries()) {
        expect(records[index]?.level).toBe(level)
        expect(records[index]?.msg).toBe(`${level} message`)
        expect(String(records[index]?.time)).toMatch(RFC3339)
      }
    })

    it('child bindings merge with and shadow parent bindings when records are capturable', () => {
      const logger = make()
      const records = capturedRecords(logger)
      if (!records) return
      const parent = logger.child({ scope: 'parent', keep: true })
      const child = parent.child({ scope: 'child' })
      const childRecords = capturedRecords(child) ?? records
      childRecords.length = 0
      child.info('bound message')
      expect(childRecords).toHaveLength(1)
      expect(childRecords[0]?.bindings).toMatchObject({ scope: 'child', keep: true })
    })
  })
}
