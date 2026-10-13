import { describe, expect, it } from "vitest";
import { parseMarkdown } from "chat";
import { createJuniorSlackAdapter } from "@/chat/slack/adapter";
import { parseContent } from "@/chat/slack/message/content";

const FULL_URL =
  "https://evals.sentry.dev/run/536be3d5-76e9-4d2c-b172-9756b5b4e6fc";
const TRUNCATED_LABEL = "evals.sentry.dev/run/…";

describe("parseContent", () => {
  it("prefers canonical formatted text", () => {
    expect(
      parseContent({
        attachments: [],
        text: `inspect ${TRUNCATED_LABEL}`,
        formatted: parseMarkdown(`inspect [${TRUNCATED_LABEL}](${FULL_URL})`),
        raw: {},
      }).text,
    ).toBe(`inspect [${TRUNCATED_LABEL}](${FULL_URL})`);
  });

  it("falls back to plain text when formatted content is empty", () => {
    expect(
      parseContent({
        attachments: [],
        text: "synthetic message",
        formatted: { type: "root", children: [] },
        raw: {},
      }).text,
    ).toBe("synthetic message");
  });

  it("falls back to raw blocks when the SDK has no text", () => {
    const content = parseContent({
      attachments: [],
      formatted: { type: "root", children: [] },
      raw: {
        blocks: [
          {
            type: "section",
            text: { type: "plain_text", text: "Visible block text" },
          },
        ],
      },
      text: "",
    });

    expect(content.text).toBe("Visible block text");
  });

  it("returns combined text and attachment presence", () => {
    const content = parseContent({
      attachments: [],
      formatted: { type: "root", children: [] },
      raw: {
        attachments: [{ fallback: "Alert fired" }],
      },
      text: "Investigate",
    });

    expect(content).toEqual({
      attachmentText: "[attachment] Alert fired",
      hasAttachments: true,
      text: "Investigate\n[attachment] Alert fired",
      topLevelText: "Investigate",
    });
  });

  it("keeps Slack mentions as tokens and converts the rest of the mrkdwn", () => {
    const adapter = createJuniorSlackAdapter({
      botToken: "xoxb-test",
      signingSecret: "test-secret",
    });
    const message = adapter.parseMessage({
      channel: "C123",
      text: "*thanks* <@U0ALICE01> for the fix in <#C0ENG0001|eng_ops> and <#C0OPS0001>",
      ts: "1712345.000100",
      type: "message",
      user: "U0ALICE01",
    });

    expect(parseContent(message).text).toBe(
      "**thanks** <@U0ALICE01> for the fix in <#C0ENG0001|eng_ops> and <#C0OPS0001>",
    );
  });
});
