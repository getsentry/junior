import { afterEach, describe, expect, it } from "vitest";
import { setDashboardConversationLinkOptions } from "@/chat/slack/dashboard-link";
import {
  buildSlackReplyBlocks,
  buildSlackReplyFooter,
} from "@/chat/slack/footer";

const originalJuniorBaseUrl = process.env.JUNIOR_BASE_URL;
const originalBetterAuthUrl = process.env.BETTER_AUTH_URL;

afterEach(() => {
  setDashboardConversationLinkOptions(undefined);
  if (originalJuniorBaseUrl === undefined) {
    delete process.env.JUNIOR_BASE_URL;
  } else {
    process.env.JUNIOR_BASE_URL = originalJuniorBaseUrl;
  }
  if (originalBetterAuthUrl === undefined) {
    delete process.env.BETTER_AUTH_URL;
  } else {
    process.env.BETTER_AUTH_URL = originalBetterAuthUrl;
  }
});

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

  it("links the ID to the core dashboard when dashboard links are configured", () => {
    setDashboardConversationLinkOptions({
      basePath: "/ops",
      baseURL: "https://junior.example.com",
    });

    expect(
      buildSlackReplyFooter({
        conversationId: "slack:C123:1700000000.000100",
      }),
    ).toEqual({
      items: [
        {
          label: "ID",
          url: "https://junior.example.com/ops/conversations/slack%3AC123%3A1700000000.000100",
          value: "slack:C123:1700000000.000100",
        },
      ],
    });
  });

  it("uses JUNIOR_BASE_URL for core dashboard footer links", () => {
    process.env.BETTER_AUTH_URL = "https://legacy-auth.example.com";
    process.env.JUNIOR_BASE_URL = "https://junior-env.example.com";
    setDashboardConversationLinkOptions({
      basePath: "/ops",
    });

    expect(
      buildSlackReplyFooter({
        conversationId: "slack:C123:1700000000.000100",
      }),
    ).toEqual({
      items: [
        {
          label: "ID",
          url: "https://junior-env.example.com/ops/conversations/slack%3AC123%3A1700000000.000100",
          value: "slack:C123:1700000000.000100",
        },
      ],
    });
  });

  it("does not link the ID to the core dashboard when dashboard is disabled", () => {
    setDashboardConversationLinkOptions({
      baseURL: "https://junior.example.com",
      disabled: true,
    });

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
