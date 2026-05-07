import { describe, expect, it } from "vitest";
import { extractCanvasId } from "@/chat/tools/slack/canvases";

describe("extractCanvasId", () => {
  it("returns an uppercased F-prefixed ID as-is", () => {
    expect(extractCanvasId("F0AU9MRL63T")).toBe("F0AU9MRL63T");
    expect(extractCanvasId("f0abcdef")).toBe("F0ABCDEF");
  });

  it("parses canvas IDs from /docs/ URLs", () => {
    expect(
      extractCanvasId("https://sentry.slack.com/docs/T024ZCV9U/F0AU9MRL63T"),
    ).toBe("F0AU9MRL63T");
  });

  it("parses canvas IDs from /canvas/ URLs", () => {
    expect(extractCanvasId("https://sentry.slack.com/canvas/F0AU9MRL63T")).toBe(
      "F0AU9MRL63T",
    );
  });

  it("parses canvas IDs from /files/ URLs", () => {
    expect(
      extractCanvasId(
        "https://sentry.slack.com/files/U123/F0AU9MRL63T/my_file.md",
      ),
    ).toBe("F0AU9MRL63T");
  });

  it("returns undefined for unparseable input", () => {
    expect(extractCanvasId("")).toBeUndefined();
    expect(extractCanvasId("https://example.com/foo")).toBeUndefined();
    expect(extractCanvasId("not-a-canvas")).toBeUndefined();
  });
});
