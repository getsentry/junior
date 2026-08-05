import { describe, expect, it } from "vitest";
import { makeStructuredToolOutput } from "@/chat/tool-support/structured-result";

describe("makeStructuredToolOutput", () => {
  it("derives model-visible content from the same structured details object", () => {
    const result = makeStructuredToolOutput({
      target: "notes.txt",
      truncated: true,
      content: "hello",
      path: "notes.txt",
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
});
