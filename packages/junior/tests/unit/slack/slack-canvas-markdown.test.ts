import { describe, expect, it } from "vitest";
import { normalizeCanvasMarkdown } from "@/chat/tools/slack/canvases";

describe("normalizeCanvasMarkdown", () => {
  it("downgrades unsupported heading depth to h3", () => {
    const normalized = normalizeCanvasMarkdown("#### Deep heading\nBody");
    expect(normalized).toEqual({
      markdown: "### Deep heading\nBody",
      normalizedHeadingCount: 1,
    });
  });

  it("preserves supported heading levels", () => {
    const normalized = normalizeCanvasMarkdown("# H1\n## H2\n### H3");
    expect(normalized).toEqual({
      markdown: "# H1\n## H2\n### H3",
      normalizedHeadingCount: 0,
    });
  });

  it("only normalizes heading lines", () => {
    const normalized = normalizeCanvasMarkdown(
      "Text\n##### Too deep\n`#### code`",
    );
    expect(normalized).toEqual({
      markdown: "Text\n### Too deep\n`#### code`",
      normalizedHeadingCount: 1,
    });
  });
});
