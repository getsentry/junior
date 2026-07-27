import { describe, expect, it } from "vitest";
import { readBoundedOAuthErrorBody } from "@/chat/oauth-response";

describe("OAuth error responses", () => {
  it("bounds provider-controlled bodies and cancels the remaining stream", async () => {
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(1024).fill(65));
      },
      cancel() {
        cancelled = true;
      },
    });

    const text = await readBoundedOAuthErrorBody(
      new Response(body, { status: 500 }),
    );

    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(16 * 1024);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(100);
  });
});
