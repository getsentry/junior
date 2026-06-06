import { describe, expect, it } from "vitest";

import { shouldCopyRawTranscript } from "../src/client/components/transcriptCopy";

function selection(
  options: {
    collapsed?: boolean;
    intersects?: boolean;
    rangeCount?: number;
    text?: string;
  } = {},
) {
  return {
    isCollapsed: options.collapsed ?? false,
    rangeCount: options.rangeCount ?? 1,
    toString: () => options.text ?? "partial text",
    getRangeAt: () => ({
      intersectsNode: () => options.intersects ?? true,
    }),
  };
}

describe("transcript copy selection", () => {
  it("uses raw transcript copy only when rich view has no active selection", () => {
    const node = {} as Node;

    expect(shouldCopyRawTranscript("rich", "full message", null, node)).toBe(
      true,
    );
    expect(
      shouldCopyRawTranscript(
        "rich",
        "full message",
        selection({ intersects: true }),
        node,
      ),
    ).toBe(false);
    expect(shouldCopyRawTranscript("raw", "full message", null, node)).toBe(
      false,
    );
    expect(shouldCopyRawTranscript("rich", "", null, node)).toBe(false);
    expect(
      shouldCopyRawTranscript(
        "rich",
        "full message",
        selection({ collapsed: true }),
        node,
      ),
    ).toBe(true);
    expect(
      shouldCopyRawTranscript(
        "rich",
        "full message",
        selection({ text: "" }),
        node,
      ),
    ).toBe(true);
    expect(
      shouldCopyRawTranscript(
        "rich",
        "full message",
        selection({ intersects: false }),
        node,
      ),
    ).toBe(true);
  });
});
