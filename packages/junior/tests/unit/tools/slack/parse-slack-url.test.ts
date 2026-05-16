import { describe, expect, it } from "vitest";
import { parseSlackMessageReference } from "@/chat/slack/tools/slack-message-url";

describe("parseSlackMessageReference", () => {
  it("parses a plain archive URL", () => {
    const result = parseSlackMessageReference(
      "https://sentry.slack.com/archives/C0AHB7N2JCR/p1700000000123456",
    );
    expect(result).toEqual({
      ok: true,
      reference: {
        channelId: "C0AHB7N2JCR",
        messageTs: "1700000000.123456",
        threadTs: undefined,
      },
    });
  });

  it("parses a reply URL with thread_ts query param", () => {
    const result = parseSlackMessageReference(
      "https://sentry.slack.com/archives/C0AHB7N2JCR/p1700000000999999?thread_ts=1700000000.000000&cid=C0AHB7N2JCR",
    );
    expect(result).toEqual({
      ok: true,
      reference: {
        channelId: "C0AHB7N2JCR",
        messageTs: "1700000000.999999",
        threadTs: "1700000000.000000",
      },
    });
  });

  it("unwraps mrkdwn angle-bracket wrapping", () => {
    const result = parseSlackMessageReference(
      "<https://sentry.slack.com/archives/C123ABC/p1700000000100000>",
    );
    expect(result).toMatchObject({
      ok: true,
      reference: {
        channelId: "C123ABC",
        messageTs: "1700000000.100000",
      },
    });
  });

  it("unwraps mrkdwn angle-bracket with label", () => {
    const result = parseSlackMessageReference(
      "<https://sentry.slack.com/archives/C123ABC/p1700000000200000|this message>",
    );
    expect(result).toMatchObject({
      ok: true,
      reference: {
        channelId: "C123ABC",
        messageTs: "1700000000.200000",
      },
    });
  });

  it("handles HTML-encoded ampersand in query string", () => {
    const result = parseSlackMessageReference(
      "https://sentry.slack.com/archives/C123/p1700000000300000?thread_ts=1700000000.000000&amp;cid=C123",
    );
    expect(result).toMatchObject({
      ok: true,
      reference: {
        channelId: "C123",
        messageTs: "1700000000.300000",
        threadTs: "1700000000.000000",
      },
    });
  });

  it("rejects non-Slack hostnames", () => {
    const result = parseSlackMessageReference(
      "https://example.com/archives/C123/p1700000000100000",
    );
    expect(result).toEqual({
      ok: false,
      error: "Not a Slack archive URL",
    });
  });

  it("rejects non-URL input", () => {
    const result = parseSlackMessageReference("not a url at all");
    expect(result).toEqual({
      ok: false,
      error: "Input is not a valid URL",
    });
  });

  it("rejects a Slack URL without an archive path", () => {
    const result = parseSlackMessageReference(
      "https://sentry.slack.com/messages/C123",
    );
    expect(result).toEqual({
      ok: false,
      error: "URL path does not match Slack archive format",
    });
  });

  it("handles DM channel IDs", () => {
    const result = parseSlackMessageReference(
      "https://sentry.slack.com/archives/D04ABCDEF/p1700000000400000",
    );
    expect(result).toMatchObject({
      ok: true,
      reference: {
        channelId: "D04ABCDEF",
        messageTs: "1700000000.400000",
      },
    });
  });

  it("handles group DM channel IDs", () => {
    const result = parseSlackMessageReference(
      "https://sentry.slack.com/archives/G04ABCDEF/p1700000000500000",
    );
    expect(result).toMatchObject({
      ok: true,
      reference: {
        channelId: "G04ABCDEF",
        messageTs: "1700000000.500000",
      },
    });
  });

  it("correctly converts p-timestamp with trailing zeros", () => {
    const result = parseSlackMessageReference(
      "https://sentry.slack.com/archives/C123/p1700000000000100",
    );
    expect(result).toMatchObject({
      ok: true,
      reference: {
        messageTs: "1700000000.000100",
      },
    });
  });

  it("rejects HTTP URLs (requires HTTPS)", () => {
    const result = parseSlackMessageReference(
      "http://sentry.slack.com/archives/C123/p1700000000100000",
    );
    expect(result).toEqual({
      ok: false,
      error: "Slack archive URL must use HTTPS",
    });
  });

  it("rejects channel IDs with invalid prefix", () => {
    const result = parseSlackMessageReference(
      "https://sentry.slack.com/archives/Z123ABC/p1700000000100000",
    );
    expect(result).toEqual({
      ok: false,
      error: "URL path does not match Slack archive format",
    });
  });

  it("rejects malformed thread_ts in query string", () => {
    const result = parseSlackMessageReference(
      "https://sentry.slack.com/archives/C123/p1700000000100000?thread_ts=garbage",
    );
    expect(result).toEqual({
      ok: false,
      error: "Invalid thread timestamp in URL",
    });
  });
});
