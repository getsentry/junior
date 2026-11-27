// Plugin response hooks read at most this much of a provider response.
const RESPONSE_BODY_TEXT_LIMIT_BYTES = 64 * 1024;

function responseContentLength(upstream: Response): number | undefined {
  const raw = upstream.headers.get("content-length");
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Read a copy of a response body as text, or undefined past `maxBytes`. */
export async function responseTextWithinLimit(
  upstream: Response,
  maxBytes: number,
): Promise<string | undefined> {
  const limit = Math.min(
    Math.max(0, Math.floor(maxBytes)),
    RESPONSE_BODY_TEXT_LIMIT_BYTES,
  );
  if (limit <= 0) {
    return undefined;
  }
  const contentLength = responseContentLength(upstream);
  if (contentLength !== undefined && contentLength > limit) {
    return undefined;
  }
  let clone: Response;
  try {
    clone = upstream.clone();
  } catch {
    return undefined;
  }
  const body = clone.body;
  if (!body) {
    return "";
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- Chunks arrive in order.
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      if (bytes > limit) {
        // The clone shares its source with the caller's body, so its cancel
        // settles only after the caller reads. Awaiting it here hangs.
        void reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}
