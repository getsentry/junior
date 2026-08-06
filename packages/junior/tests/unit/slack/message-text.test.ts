import { describe, expect, it } from "vitest";
import { Message, parseMarkdown } from "chat";
import {
  expandSlackMrkdwnLinks,
  getSlackMessageAgentText,
  getSlackMessageSourceText,
} from "@/chat/slack/message";

const FULL_URL =
  "https://evals.sentry.dev/run/536be3d5-76e9-4d2c-b172-9756b5b4e6fc";
const TRUNCATED_LABEL = "evals.sentry.dev/run/…";

function createMessage(args: {
  text: string;
  rawText?: string;
  formattedMarkdown?: string;
}) {
  return new Message({
    id: "1700000000.000100",
    threadId: "slack:C123:1700000000.000100",
    text: args.text,
    formatted: args.formattedMarkdown
      ? parseMarkdown(args.formattedMarkdown)
      : { type: "root", children: [] },
    raw: args.rawText === undefined ? {} : { text: args.rawText },
    author: {
      userId: "U123",
      userName: "ryan",
      fullName: "Ryan Brooks",
      isBot: false,
      isMe: false,
    },
    metadata: {
      dateSent: new Date("2026-06-05T00:00:00.000Z"),
      edited: false,
    },
    attachments: [],
  });
}

describe("expandSlackMrkdwnLinks", () => {
  it("keeps full URL targets from labeled Slack links", () => {
    expect(
      expandSlackMrkdwnLinks(
        `please inspect <${FULL_URL}|${TRUNCATED_LABEL}> thanks`,
      ),
    ).toBe(`please inspect [${TRUNCATED_LABEL}](${FULL_URL}) thanks`);
  });

  it("unwraps bare Slack links", () => {
    expect(expandSlackMrkdwnLinks(`see <${FULL_URL}>`)).toBe(`see ${FULL_URL}`);
  });
});

describe("getSlackMessageSourceText", () => {
  it("prefers original Slack event text over adapter plain text", () => {
    const message = createMessage({
      text: `please inspect ${TRUNCATED_LABEL}`,
      rawText: `please inspect <${FULL_URL}|${TRUNCATED_LABEL}>`,
    });

    expect(getSlackMessageSourceText(message)).toBe(
      `please inspect <${FULL_URL}|${TRUNCATED_LABEL}>`,
    );
  });

  it("falls back to message.text when raw event text is absent", () => {
    const message = createMessage({
      text: "hello without raw",
    });

    expect(getSlackMessageSourceText(message)).toBe("hello without raw");
  });
});

describe("getSlackMessageAgentText", () => {
  it("uses formatted markdown so truncated labels keep full URLs", () => {
    const message = createMessage({
      text: `can you tell me why all scenarios in ${TRUNCATED_LABEL} failed?`,
      rawText: `can you tell me why all scenarios in <${FULL_URL}|${TRUNCATED_LABEL}> failed?`,
      formattedMarkdown: `can you tell me why all scenarios in [${TRUNCATED_LABEL}](${FULL_URL}) failed?`,
    });

    expect(getSlackMessageAgentText(message)).toContain(FULL_URL);
    expect(getSlackMessageAgentText(message)).toContain(
      `[${TRUNCATED_LABEL}](${FULL_URL})`,
    );
  });

  it("expands raw mrkdwn links when formatted content is empty", () => {
    const message = createMessage({
      text: `please inspect ${TRUNCATED_LABEL}`,
      rawText: `please inspect <${FULL_URL}|${TRUNCATED_LABEL}>`,
    });

    expect(getSlackMessageAgentText(message)).toBe(
      `please inspect [${TRUNCATED_LABEL}](${FULL_URL})`,
    );
  });

  it("preserves bare full urls from raw mrkdwn", () => {
    const message = createMessage({
      text: FULL_URL,
      rawText: `<${FULL_URL}>`,
    });

    expect(getSlackMessageAgentText(message)).toBe(FULL_URL);
  });
});
