import { afterEach, describe, expect, it, vi } from "vitest";

type MockDsn = {
  host: string;
  path?: string;
  port?: string;
  projectId: string;
  protocol: "http" | "https";
};

function mockSentryClient(args: { dsn?: MockDsn; orgId?: number | string }) {
  vi.doMock("@/chat/sentry", () => ({
    getClient: () => ({
      getDsn: () => args.dsn,
      getOptions: () => ({
        orgId: args.orgId,
      }),
    }),
  }));
}

async function loadFooter() {
  return await import("@/chat/slack/footer");
}

afterEach(() => {
  delete process.env.SENTRY_ORG_SLUG;
  vi.doUnmock("@/chat/sentry");
  vi.resetModules();
});

describe("Slack footer Sentry links", () => {
  it("links the ID to an Explore traces search using org slug subdomain for SaaS", async () => {
    process.env.SENTRY_ORG_SLUG = "my-org";
    mockSentryClient({
      dsn: {
        protocol: "https",
        host: "o123.ingest.us.sentry.io",
        projectId: "4501",
      },
    });

    const { buildSlackReplyBlocks, buildSlackReplyFooter } = await loadFooter();
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
            text: "*ID:* <https://my-org.sentry.io/explore/traces/?query=gen_ai.conversation.id%3A%22slack%3AC123%3A1700000000.000100%22&amp;project=4501&amp;statsPeriod=14d|slack:C123:1700000000.000100>",
          },
        ],
      },
    ]);
  });

  it("leaves the ID plain when SENTRY_ORG_SLUG is not set even with numeric org data", async () => {
    mockSentryClient({
      dsn: {
        protocol: "https",
        host: "o123.ingest.sentry.io",
        projectId: "4501",
      },
      orgId: 456,
    });

    const { buildSlackReplyFooter } = await loadFooter();

    expect(buildSlackReplyFooter({ conversationId: "conversation-1" })).toEqual(
      {
        items: [
          {
            label: "ID",
            value: "conversation-1",
          },
        ],
      },
    );
  });

  it("uses /organizations/{slug}/ for self-hosted DSN", async () => {
    process.env.SENTRY_ORG_SLUG = "my-org";
    mockSentryClient({
      dsn: {
        protocol: "https",
        host: "sentry.example.com",
        projectId: "4501",
      },
    });

    const { buildSlackReplyFooter } = await loadFooter();

    expect(buildSlackReplyFooter({ conversationId: "conversation-1" })).toEqual(
      {
        items: [
          {
            label: "ID",
            url: "https://sentry.example.com/organizations/my-org/explore/traces/?query=gen_ai.conversation.id%3A%22conversation-1%22&project=4501&statsPeriod=14d",
            value: "conversation-1",
          },
        ],
      },
    );
  });

  it("leaves the ID plain when the active DSN has no organization target", async () => {
    mockSentryClient({
      dsn: {
        protocol: "https",
        host: "sentry.example.com",
        projectId: "4501",
      },
    });

    const { buildSlackReplyFooter } = await loadFooter();

    expect(buildSlackReplyFooter({ conversationId: "conversation-1" })).toEqual(
      {
        items: [
          {
            label: "ID",
            value: "conversation-1",
          },
        ],
      },
    );
  });
});
