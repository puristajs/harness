import { webcrypto } from 'node:crypto'

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const RANDOM_MAX = (1n << 80n) - 1n

let lastTime = -1
let lastRandom = 0n

function encode(value: bigint, length: number): string {
  let out = ''
  let input = value
  const base = 32n
  for (let i = 0; i < length; i += 1) {
    const index = Number(input % base)
    out = ENCODING[index] + out
    input /= base
  }
  return out
}

/** Cryptographically-strong 80-bit random component. */
function randomEntropy(): bigint {
  const bytes = new Uint8Array(10)
  webcrypto.getRandomValues(bytes)
  let value = 0n
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte)
  }
  return value
}

/**
 * Generates a monotonic ULID-like identifier.
 *
 * Ordering is guaranteed even across same-millisecond bursts and wall-clock
 * regressions: the time component never moves backward (it is clamped to a
 * monotonic high-water mark), and within a millisecond the 80-bit random
 * component is incremented. Each new millisecond seeds the random component
 * from a cryptographically-strong source, so intra-millisecond collisions are
 * negligible across calls and processes.
 */
export function ulid(): string {
  const now = Date.now()
  if (now > lastTime) {
    lastTime = now
    lastRandom = randomEntropy()
  } else {
    // Same millisecond or a backward clock step: keep ordering by never
    // emitting a smaller time, and advance the random component instead.
    lastRandom += 1n
    if (lastRandom > RANDOM_MAX) {
      lastTime += 1
      lastRandom = randomEntropy()
    }
  }
  return `${encode(BigInt(lastTime), 10)}${encode(lastRandom, 16)}`
}
