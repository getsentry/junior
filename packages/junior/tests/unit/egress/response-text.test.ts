import { describe, expect, it } from "vitest";
import { responseTextWithinLimit } from "@/chat/egress/response-text";

function chunkedResponse(totalBytes: number, chunkBytes: number): Response {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunkBytes, totalBytes - sent);
      controller.enqueue(new Uint8Array(size).fill(97));
      sent += size;
    },
  });
  // A stream body has no content-length, like a chunked gzip response.
  return new Response(body, { status: 200 });
}

describe("responseTextWithinLimit", () => {
  it("returns past the limit and leaves the full body to the caller", async () => {
    const upstream = chunkedResponse(200 * 1024, 8 * 1024);
    expect(upstream.headers.get("content-length")).toBeNull();

    await expect(responseTextWithinLimit(upstream, 64 * 1024)).resolves.toBe(
      undefined,
    );
    const text = await upstream.text();
    expect(text.length).toBe(200 * 1024);
  });
});
