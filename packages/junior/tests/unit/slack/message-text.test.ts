import { describe, expect, it } from "vitest";
import { parseMarkdown } from "chat";
import { getSlackMessageText } from "@/chat/slack/message";

const FULL_URL =
  "https://evals.sentry.dev/run/536be3d5-76e9-4d2c-b172-9756b5b4e6fc";
const TRUNCATED_LABEL = "evals.sentry.dev/run/…";

describe("getSlackMessageText", () => {
  it("prefers canonical formatted text", () => {
    expect(
      getSlackMessageText({
        text: `inspect ${TRUNCATED_LABEL}`,
        formatted: parseMarkdown(`inspect [${TRUNCATED_LABEL}](${FULL_URL})`),
      }),
    ).toBe(`inspect [${TRUNCATED_LABEL}](${FULL_URL})`);
  });

  it("falls back to plain text when formatted content is empty", () => {
    expect(
      getSlackMessageText({
        text: "synthetic message",
        formatted: { type: "root", children: [] },
      }),
    ).toBe("synthetic message");
  });

  it("falls back to plain text when formatted content is missing", () => {
    expect(
      getSlackMessageText({
        text: "plain only message",
      }),
    ).toBe("plain only message");
  });
});
