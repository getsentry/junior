import { describe, expect, it } from "vitest";
import { extractCanvasId } from "@/chat/slack/tools/canvas/api";

describe("extractCanvasId", () => {
  it("returns an uppercased F-prefixed ID as-is", () => {
    expect(extractCanvasId("F0AU9MRL63T")).toBe("F0AU9MRL63T");
    expect(extractCanvasId("FABCD12345")).toBe("FABCD12345");
    expect(extractCanvasId("f0abcdef")).toBe("F0ABCDEF");
  });

  it("parses canvas IDs from /docs/ URLs", () => {
    expect(
      extractCanvasId("https://sentry.slack.com/docs/T024ZCV9U/F0AU9MRL63T"),
    ).toBe("F0AU9MRL63T");
    expect(
      extractCanvasId("https://sentry.slack.com/docs/T024ZCV9U/FABCD12345"),
    ).toBe("FABCD12345");
    expect(
      extractCanvasId(
        "<https://sentry.slack.com/docs/T024ZCV9U/F0AU9MRL63T|Canvas>",
      ),
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
    expect(extractCanvasId("file")).toBeUndefined();
    expect(extractCanvasId("https://example.com/foo")).toBeUndefined();
    expect(
      extractCanvasId("https://example.com/docs/T024ZCV9U/F0AU9MRL63T"),
    ).toBeUndefined();
    expect(extractCanvasId("not-a-canvas")).toBeUndefined();
  });
});
