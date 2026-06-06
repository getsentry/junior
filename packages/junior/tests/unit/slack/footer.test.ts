import { describe, expect, it } from "vitest";
import {
  buildSlackReplyBlocks,
  buildSlackReplyFooter,
} from "@/chat/slack/footer";

describe("buildSlackReplyFooter", () => {
  it("returns a compact footer item for the conversation ID", () => {
    expect(
      buildSlackReplyFooter({
        conversationId: "  slack:C123:1700000000.000100  ",
      }),
    ).toEqual({
      items: [
        {
          label: "ID",
          value: "slack:C123:1700000000.000100",
        },
      ],
    });
  });

  it("keeps ID as plain text when no conversation URL is available", () => {
    expect(
      buildSlackReplyFooter({
        conversationId: "slack:C123:1700000000.000100",
      }),
    ).toEqual({
      items: [
        {
          label: "ID",
          value: "slack:C123:1700000000.000100",
        },
      ],
    });
  });

  it("omits the footer when no items are available", () => {
    expect(buildSlackReplyFooter({})).toBeUndefined();
  });
});

describe("buildSlackReplyBlocks", () => {
  it("renders the reply body as a markdown block plus a context footer", () => {
    const footer = buildSlackReplyFooter({
      conversationId: "slack:C123:1700000000.000100",
    });

    expect(buildSlackReplyBlocks("Hello world", footer)).toEqual([
      {
        type: "markdown",
        text: "Hello world",
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "*ID:* slack:C123:1700000000.000100",
          },
        ],
      },
    ]);
  });

  it("renders a markdown block without footer when footer is undefined", () => {
    expect(buildSlackReplyBlocks("Hello world", undefined)).toEqual([
      {
        type: "markdown",
        text: "Hello world",
      },
    ]);
  });

  it("does not emit blocks when the reply has no visible text", () => {
    const footer = buildSlackReplyFooter({
      conversationId: "slack:C123:1700000000.000100",
    });

    expect(buildSlackReplyBlocks("   ", footer)).toBeUndefined();
  });
});
