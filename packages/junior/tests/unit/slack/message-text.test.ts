import { describe, expect, it } from "vitest";
import { getSlackMessageText } from "@/chat/slack/message";

const FULL_URL =
  "https://evals.sentry.dev/run/536be3d5-76e9-4d2c-b172-9756b5b4e6fc";
const TRUNCATED_LABEL = "evals.sentry.dev/run/…";

describe("getSlackMessageText", () => {
  it("appends structured link targets missing from plain text", () => {
    expect(
      getSlackMessageText({
        text: `inspect ${TRUNCATED_LABEL}`,
        links: [{ url: FULL_URL }],
      }),
    ).toBe(`inspect ${TRUNCATED_LABEL}\n\nLinks:\n${FULL_URL}`);
  });

  it("does not duplicate targets already present in plain text", () => {
    expect(
      getSlackMessageText({
        text: `inspect ${FULL_URL}`,
        links: [{ url: FULL_URL }],
      }),
    ).toBe(`inspect ${FULL_URL}`);
  });

  it("deduplicates missing structured targets", () => {
    expect(
      getSlackMessageText({
        text: "inspect these",
        links: [{ url: FULL_URL }, { url: FULL_URL }],
      }),
    ).toBe(`inspect these\n\nLinks:\n${FULL_URL}`);
  });
});
