import { describe, expect, it } from "vitest";
import { toWebStream } from "@/core/tool-execution-environment/web-stream";

describe("toWebStream", () => {
  it("stops the source on cancel, before it reads to the end", async () => {
    const pulled: number[] = [];
    let closed = false;
    async function* source() {
      try {
        for (const index of [1, 2, 3]) {
          pulled.push(index);
          yield new Uint8Array([index]);
        }
      } finally {
        closed = true;
      }
    }

    const reader = toWebStream(source()).getReader();
    expect(await reader.read()).toEqual({
      done: false,
      value: new Uint8Array([1]),
    });
    await reader.cancel();

    // The stream may read one chunk ahead, so only the last one is certain.
    expect(closed).toBe(true);
    expect(pulled).not.toContain(3);
  });

  it("encodes string chunks as UTF-8 and closes when the source ends", async () => {
    async function* source() {
      yield "héllo ";
      yield new TextEncoder().encode("wörld");
    }

    const text = await new Response(toWebStream(source())).text();

    expect(text).toBe("héllo wörld");
  });
});
