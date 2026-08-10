import { describe, expect, it } from "vitest";
import { normalizeCanvasMarkdown } from "@/chat/slack/tool-support/canvas/markdown";

describe("normalizeCanvasMarkdown", () => {
  it("downgrades unsupported heading depth to h3", () => {
    const normalized = normalizeCanvasMarkdown("#### Deep heading\nBody");
    expect(normalized).toEqual({
      markdown: "### Deep heading\nBody",
      normalizedCount: 1,
      normalizedHeadingCount: 1,
      normalizedMixedListCount: 0,
      unwrappedBlockquoteCount: 0,
    });
  });

  it("preserves supported heading levels", () => {
    const normalized = normalizeCanvasMarkdown("# H1\n## H2\n### H3");
    expect(normalized).toEqual({
      markdown: "# H1\n## H2\n### H3",
      normalizedCount: 0,
      normalizedHeadingCount: 0,
      normalizedMixedListCount: 0,
      unwrappedBlockquoteCount: 0,
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
      normalizedMixedListCount: 0,
      unwrappedBlockquoteCount: 0,
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

  it("uses plain bullet markers inside numbered lists", () => {
    const normalized = normalizeCanvasMarkdown(
      "1. Parent\n   - Child\n2. Next",
    );
    expect(normalized.markdown).toBe("1. Parent\n   • Child\n2. Next");
    expect(normalized.normalizedMixedListCount).toBe(1);
    expect(normalized.normalizedCount).toBe(1);
  });

  it("uses plain numbered markers inside bullet lists", () => {
    const normalized = normalizeCanvasMarkdown("- Parent\n  1. Child");
    expect(normalized.markdown).toBe("- Parent\n  1: Child");
    expect(normalized.normalizedMixedListCount).toBe(1);
  });

  it("preserves sibling hierarchy when normalizing mixed nested lists", () => {
    const normalized = normalizeCanvasMarkdown(
      "1. Parent\n   - First\n   - Second\n2. Next",
    );
    expect(normalized.markdown).toBe(
      "1. Parent\n   • First\n   • Second\n2. Next",
    );
    expect(normalized.normalizedMixedListCount).toBe(2);
  });

  it("uses the normalized parent type for deeper descendants", () => {
    const normalized = normalizeCanvasMarkdown(
      "1. Root\n   - Child\n     - Grandchild\n2. Next",
    );
    expect(normalized.markdown).toBe(
      "1. Root\n   • Child\n     • Grandchild\n2. Next",
    );
    expect(normalized.normalizedMixedListCount).toBe(2);
  });

  it("preserves nested lists with the same list type", () => {
    const markdown = "1. Parent\n   1. Child\n- Parent\n  - Child";
    expect(normalizeCanvasMarkdown(markdown).markdown).toBe(markdown);
  });

  it("unwraps blockquotes inside list items without changing indentation", () => {
    const normalized = normalizeCanvasMarkdown(
      "1. Parent\n   > Quoted child\n   > More detail\n2. Next",
    );
    expect(normalized.markdown).toBe(
      "1. Parent\n   Quoted child\n   More detail\n2. Next",
    );
    expect(normalized.unwrappedBlockquoteCount).toBe(2);
    expect(normalized.normalizedCount).toBe(2);
  });

  it("uses absolute tab stops for list content indentation", () => {
    const normalized = normalizeCanvasMarkdown(
      "1.\tParent\n    > Quoted child\n2. Next",
    );
    expect(normalized.markdown).toBe("1.\tParent\n    Quoted child\n2. Next");
    expect(normalized.unwrappedBlockquoteCount).toBe(1);
  });

  it("unwraps blockquotes that start in same-line list content", () => {
    const normalized = normalizeCanvasMarkdown(
      "1. > > Same-line quote\n2. Next",
    );
    expect(normalized.markdown).toBe("1. Same-line quote\n2. Next");
    expect(normalized.unwrappedBlockquoteCount).toBe(1);
  });

  it("normalizes list syntax revealed by unwrapped blockquotes", () => {
    const normalized = normalizeCanvasMarkdown(
      "1. Parent\n   > - Child\n2. Next",
    );
    expect(normalized.markdown).toBe("1. Parent\n   • Child\n2. Next");
    expect(normalized.unwrappedBlockquoteCount).toBe(1);
    expect(normalized.normalizedMixedListCount).toBe(1);
    expect(normalized.normalizedCount).toBe(2);
  });

  it("normalizes headings revealed by spaced nested quote markers", () => {
    const normalized = normalizeCanvasMarkdown(
      "1. Parent\n   > > #### Deep heading\n2. Next",
    );
    expect(normalized.markdown).toBe("1. Parent\n   ### Deep heading\n2. Next");
    expect(normalized.unwrappedBlockquoteCount).toBe(1);
    expect(normalized.normalizedHeadingCount).toBe(1);
    expect(normalized.normalizedCount).toBe(2);
  });

  it("normalizes deeply indented headings inside list items", () => {
    const normalized = normalizeCanvasMarkdown(
      "1. Parent\n     #### Deep heading\n2. Next",
    );
    expect(normalized.markdown).toBe(
      "1. Parent\n     ### Deep heading\n2. Next",
    );
    expect(normalized.normalizedHeadingCount).toBe(1);
  });

  it("preserves deeply indented heading syntax outside lists", () => {
    const markdown = "    #### Indented code";
    expect(normalizeCanvasMarkdown(markdown).markdown).toBe(markdown);
  });

  it("preserves headings in list-item indented code", () => {
    const markdown = "1. Parent\n       #### Indented code\n2. Next";
    expect(normalizeCanvasMarkdown(markdown).markdown).toBe(markdown);
  });

  it("preserves quote markers in list-item indented code", () => {
    const markdown = "1. Parent\n       > Indented code\n2. Next";
    expect(normalizeCanvasMarkdown(markdown).markdown).toBe(markdown);
  });

  it("preserves syntax inside deeply indented list code fences", () => {
    const markdown =
      "1. Parent\n     ```markdown\n     1. Example\n        - Keep bullet\n     #### Keep heading\n     ```\n2. Next";
    expect(normalizeCanvasMarkdown(markdown).markdown).toBe(markdown);
  });

  it("unwraps quote-wrapped list code fences without changing their content", () => {
    const normalized = normalizeCanvasMarkdown(
      "1. Parent\n   > ```markdown\n   > #### Keep heading\n   > - Keep bullet\n   > ```\n2. Next",
    );
    expect(normalized.markdown).toBe(
      "1. Parent\n   ```markdown\n   #### Keep heading\n   - Keep bullet\n   ```\n2. Next",
    );
    expect(normalized.unwrappedBlockquoteCount).toBe(4);
    expect(normalized.normalizedHeadingCount).toBe(0);
    expect(normalized.normalizedMixedListCount).toBe(0);
  });

  it("preserves inner quotes in quote-wrapped list code fences", () => {
    const normalized = normalizeCanvasMarkdown(
      "1. Parent\n   > > ```markdown\n   > > > Quoted example\n   > > ```\n2. Next",
    );
    expect(normalized.markdown).toBe(
      "1. Parent\n   ```markdown\n   > Quoted example\n   ```\n2. Next",
    );
    expect(normalized.unwrappedBlockquoteCount).toBe(3);
    expect(normalized.normalizedHeadingCount).toBe(0);
    expect(normalized.normalizedMixedListCount).toBe(0);
  });

  it("preserves top-level blockquotes", () => {
    const markdown = "> Quote\n> More detail";
    expect(normalizeCanvasMarkdown(markdown).markdown).toBe(markdown);
  });

  it("is idempotent after normalizing rejected markdown", () => {
    const first = normalizeCanvasMarkdown(
      "#### Heading\n1. Parent\n   > - Child\n   > > #### Deep heading",
    );
    const second = normalizeCanvasMarkdown(first.markdown);

    expect(second.markdown).toBe(first.markdown);
    expect(second.normalizedCount).toBe(0);
  });
});
