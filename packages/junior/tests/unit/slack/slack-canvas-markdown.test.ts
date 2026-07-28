import { describe, expect, it } from "vitest";
import { normalizeCanvasMarkdown } from "@/chat/slack/tools/canvas/markdown";

describe("normalizeCanvasMarkdown", () => {
  it("downgrades unsupported heading depth to h3", () => {
    const normalized = normalizeCanvasMarkdown("#### Deep heading\nBody");
    expect(normalized).toEqual({
      markdown: "### Deep heading\nBody",
      normalizedCount: 1,
      normalizedHeadingCount: 1,
      flattenedMixedListCount: 0,
      flattenedBlockquoteCount: 0,
    });
  });

  it("preserves supported heading levels", () => {
    const normalized = normalizeCanvasMarkdown("# H1\n## H2\n### H3");
    expect(normalized).toEqual({
      markdown: "# H1\n## H2\n### H3",
      normalizedCount: 0,
      normalizedHeadingCount: 0,
      flattenedMixedListCount: 0,
      flattenedBlockquoteCount: 0,
    });
  });

  it("only normalizes heading lines", () => {
    const normalized = normalizeCanvasMarkdown(
      "Text\n##### Too deep\n`#### code`",
    );
    expect(normalized).toEqual({
      markdown: "Text\n### Too deep\n`#### code`",
      normalizedCount: 1,
      normalizedHeadingCount: 1,
      flattenedMixedListCount: 0,
      flattenedBlockquoteCount: 0,
    });
  });

  it("preserves markdown syntax inside fenced code blocks", () => {
    const markdown = "```markdown\n#### Heading\n1. Parent\n   - Child\n```";
    expect(normalizeCanvasMarkdown(markdown).markdown).toBe(markdown);
  });

  it("does not close a longer fence with a shorter fence", () => {
    const markdown = "````markdown\n```\n#### Heading\n```\n````";
    expect(normalizeCanvasMarkdown(markdown).markdown).toBe(markdown);
  });

  it("flattens bullet lists nested inside numbered lists", () => {
    const normalized = normalizeCanvasMarkdown(
      "1. Parent\n   - Child\n2. Next",
    );
    expect(normalized.markdown).toBe("1. Parent\n- Child\n2. Next");
    expect(normalized.flattenedMixedListCount).toBe(1);
    expect(normalized.normalizedCount).toBe(1);
  });

  it("flattens numbered lists nested inside bullet lists", () => {
    const normalized = normalizeCanvasMarkdown("- Parent\n  1. Child");
    expect(normalized.markdown).toBe("- Parent\n1. Child");
    expect(normalized.flattenedMixedListCount).toBe(1);
  });

  it("preserves nested lists with the same list type", () => {
    const markdown = "1. Parent\n   1. Child\n- Parent\n  - Child";
    expect(normalizeCanvasMarkdown(markdown).markdown).toBe(markdown);
  });

  it("moves blockquotes out of list items", () => {
    const normalized = normalizeCanvasMarkdown(
      "1. Parent\n   > Quoted child\n   > More detail\n2. Next",
    );
    expect(normalized.markdown).toBe(
      "1. Parent\n> Quoted child\n> More detail\n2. Next",
    );
    expect(normalized.flattenedBlockquoteCount).toBe(2);
    expect(normalized.normalizedCount).toBe(2);
  });

  it("preserves top-level blockquotes", () => {
    const markdown = "> Quote\n> More detail";
    expect(normalizeCanvasMarkdown(markdown).markdown).toBe(markdown);
  });

  it("is idempotent after normalizing rejected markdown", () => {
    const first = normalizeCanvasMarkdown(
      "#### Heading\n1. Parent\n   - Child\n   > Quote",
    );
    const second = normalizeCanvasMarkdown(first.markdown);

    expect(second.markdown).toBe(first.markdown);
    expect(second.normalizedCount).toBe(0);
  });
});
