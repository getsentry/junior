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
  it("links the ID to the conversations page using org slug subdomain for SaaS", async () => {
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
            text: "*ID:* <https://my-org.sentry.io/explore/conversations/slack%3AC123%3A1700000000.000100/?project=4501|slack:C123:1700000000.000100>",
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
            url: "https://sentry.example.com/organizations/my-org/explore/conversations/conversation-1/?project=4501",
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
