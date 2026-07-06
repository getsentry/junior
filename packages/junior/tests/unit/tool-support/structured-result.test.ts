import { describe, expect, it } from "vitest";
import { makeStructuredToolResult } from "@/chat/tool-support/structured-result";

describe("makeStructuredToolResult", () => {
  it("derives model-visible content from the same structured details object", () => {
    const result = makeStructuredToolResult({
      ok: true,
      status: "success",
      target: "notes.txt",
      truncated: true,
      data: {
        content: "hello",
        path: "notes.txt",
      },
      continuation: {
        arguments: {
          path: "notes.txt",
          offset: 2,
          limit: 1,
        },
      },
    });

    expect(JSON.parse(result.content[0]!.text)).toEqual(result.details);
  });

  it("rejects malformed structured results as runtime contract failures", () => {
    expect(() =>
      makeStructuredToolResult({
        ok: true,
      } as never),
    ).toThrow("Invalid option");
  });
});
