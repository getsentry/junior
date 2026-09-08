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

  it("renders auth-pause-style text (leading mention, CommonMark bold, embedded URL) as a leading mention context block plus a markdown body", async () => {
    // Regression test for JUNIOR-72: Slack's `markdown` block has no
    // user-mention syntax (docs.slack.dev/reference/block-kit/blocks/markdown-block).
    // A literal `<@id>` mention left inside that block made Slack's
    // markdown-to-rich_text conversion reject the auth-pause notice as
    // invalid_blocks. buildAuthPauseResponse's leading mention must be split
    // into its own `mrkdwn` context block instead.
    const { buildAuthPauseResponse } = await import(
      "@/chat/services/auth-pause-response"
    );
    const text = buildAuthPauseResponse(
      "U123",
      "GitHub",
      "check out https://github.com/foo/bar and proceed",
    );

    expect(text).toBe(
      "<@U123> I need access to GitHub to continue.\n\n**Why:** check out https://github.com/foo/bar and proceed\n\nI sent you a link.",
    );
    expect(buildSlackReplyBlocks(text, undefined)).toEqual([
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "<@U123>" }],
      },
      {
        type: "markdown",
        text: "I need access to GitHub to continue.\n\n**Why:** check out https://github.com/foo/bar and proceed\n\nI sent you a link.",
      },
    ]);
  });

  it("drops the markdown block for a mention-only reply", () => {
    expect(buildSlackReplyBlocks("<@U123> ", undefined)).toEqual([
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "<@U123>" }],
      },
    ]);
  });

  it("does not treat a mention elsewhere in the text as a leading mention", () => {
    expect(buildSlackReplyBlocks("cc <@U123> please review", undefined)).toEqual([
      {
        type: "markdown",
        text: "cc <@U123> please review",
      },
    ]);
  });
});

describe("getDashboardTaskLink", () => {
  it("builds a task detail URL when dashboard links are configured", async () => {
    const { getDashboardTaskLink } = await import(
      "@/chat/slack/dashboard-link"
    );
    setDashboardConversationLinkOptions({
      basePath: "/ops",
      baseURL: "https://junior.example.com",
    });

    expect(getDashboardTaskLink("sched_abc")).toBe(
      "https://junior.example.com/ops/tasks/sched_abc",
    );
  });

  it("returns undefined when dashboard links are disabled", async () => {
    const { getDashboardTaskLink } = await import(
      "@/chat/slack/dashboard-link"
    );
    expect(getDashboardTaskLink("sched_abc")).toBeUndefined();
  });
});
