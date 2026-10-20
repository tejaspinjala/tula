import { timingSafeEqual } from 'node:crypto'

/**
 * Compares two secret-derived strings (MACs, signatures) in constant time over equal-length
 * buffers; a length mismatch is simply false.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
