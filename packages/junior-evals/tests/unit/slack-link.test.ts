import { describe, expect, it } from "vitest";
import { parseSlackMrkdwnLinkUrl } from "../../src/slack-link";

describe("parseSlackMrkdwnLinkUrl", () => {
  it("decodes escaped OAuth query separators", () => {
    const url = parseSlackMrkdwnLinkUrl(
      "<https://auth.example.test/authorize?client_id=test&amp;state=session-1|Authorize>",
    );

    expect(url?.searchParams.get("client_id")).toBe("test");
    expect(url?.searchParams.get("state")).toBe("session-1");
  });
});
