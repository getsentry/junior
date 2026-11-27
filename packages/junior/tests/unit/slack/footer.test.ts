import { describe, expect, it } from "vitest";
import {
  buildSlackReplyBlocks,
  buildSlackReplyFooter,
} from "@/chat/slack/footer";
import { patchConfig, useConfig } from "../../fixtures/config";

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

  it("links the conversation ID to the core dashboard", () => {
    patchConfig({
      dashboard: {
        basePath: "/ops",
        baseURL: "https://junior.example.com",
      },
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
    expect(
      buildSlackReplyBlocks(
        "",
        buildSlackReplyFooter({
          conversationId: "slack:C123:1700000000.000100",
        }),
      ),
    ).toEqual([
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "*ID:* <https://junior.example.com/ops/conversations/slack%3AC123%3A1700000000.000100|slack:C123:1700000000.000100>",
          },
        ],
      },
    ]);
  });

  it("uses JUNIOR_BASE_URL for core dashboard footer links", () => {
    useConfig(
      { dashboard: { basePath: "/ops" } },
      {
        BETTER_AUTH_URL: "https://legacy-auth.example.com",
        JUNIOR_BASE_URL: "https://junior-env.example.com",
      },
    );

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
    patchConfig({
      dashboard: {
        baseURL: "https://junior.example.com",
        disabled: true,
      },
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

  it("keeps the footer for replies with only attachments", () => {
    const footer = buildSlackReplyFooter({
      conversationId: "slack:C123:1700000000.000100",
    });

    expect(buildSlackReplyBlocks("   ", footer)).toEqual([
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: "*ID:* slack:C123:1700000000.000100" },
        ],
      },
    ]);
  });
});

describe("getDashboardTaskLink", () => {
  it("builds an automation detail URL when dashboard links are configured", async () => {
    const { getDashboardTaskLink } = await import("@/chat/dashboard-link");
    patchConfig({
      dashboard: {
        basePath: "/ops",
        baseURL: "https://junior.example.com",
      },
    });

    expect(getDashboardTaskLink("sched_abc")).toBe(
      "https://junior.example.com/ops/automations/sched_abc",
    );
  });

  it("returns undefined when dashboard links are disabled", async () => {
    const { getDashboardTaskLink } = await import("@/chat/dashboard-link");
    expect(getDashboardTaskLink("sched_abc")).toBeUndefined();
  });
});
