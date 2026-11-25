/**
 * Wraps an async iterable of bytes as a web stream, which is what
 * `ToolExecutionEnvironment.readFile` returns. Cancelling the stream ends the
 * iterator, which closes its source.
 */
export function toWebStream(
  source: AsyncIterable<string | Uint8Array>,
): ReadableStream<Uint8Array> {
  const chunks = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await chunks.next();
      if (next.done) {
        controller.close();
        return;
      }
      controller.enqueue(
        typeof next.value === "string"
          ? new TextEncoder().encode(next.value)
          : next.value,
      );
    },
    async cancel() {
      await chunks.return?.();
    },
  });
}
