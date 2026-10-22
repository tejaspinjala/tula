/** Reads a request body, stopping as soon as it exceeds `limit`; null means over the limit. */
export async function readCapped(body: ReadableStream<Uint8Array> | null, limit: number) {
  const chunks: Uint8Array[] = []
  let total = 0
  if (body) {
    const reader = body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      total += value.byteLength
      if (total > limit) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
