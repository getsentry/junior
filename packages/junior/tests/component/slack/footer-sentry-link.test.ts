import { beforeEach, describe, expect, it, vi } from "vitest";

type MockDsn = {
  host: string;
  path?: string;
  port?: string;
  projectId: string;
  protocol: "http" | "https";
};

type MockSentryClient = { dsn?: MockDsn; orgId?: number | string };

const { sentryClient } = vi.hoisted(() => ({
  sentryClient: { current: {} as MockSentryClient },
}));

vi.mock("@/chat/sentry", () => ({
  getClient: () => ({
    getDsn: () => sentryClient.current.dsn,
    getOptions: () => ({
      orgId: sentryClient.current.orgId,
    }),
  }),
}));

import {
  buildSlackReplyBlocks,
  buildSlackReplyFooter,
} from "@/chat/slack/footer";
import { useConfig } from "../../fixtures/config";

function mockSentryClient(args: MockSentryClient) {
  sentryClient.current = args;
}

beforeEach(() => {
  sentryClient.current = {};
  useConfig({}, { SENTRY_ORG_SLUG: undefined });
});

describe("Slack footer Sentry links", () => {
  it("links to the conversations page using org slug subdomain for SaaS", () => {
    useConfig({}, { SENTRY_ORG_SLUG: "my-org" });
    mockSentryClient({
      dsn: {
        protocol: "https",
        host: "o123.ingest.us.sentry.io",
        projectId: "4501",
      },
    });

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

  it("leaves the ID plain when SENTRY_ORG_SLUG is not set even with numeric org data", () => {
    mockSentryClient({
      dsn: {
        protocol: "https",
        host: "o123.ingest.sentry.io",
        projectId: "4501",
      },
      orgId: 456,
    });

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

  it("uses /organizations/{slug}/ for self-hosted DSN", () => {
    useConfig({}, { SENTRY_ORG_SLUG: "my-org" });
    mockSentryClient({
      dsn: {
        protocol: "https",
        host: "sentry.example.com",
        projectId: "4501",
      },
    });

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

  it("leaves the ID plain when the active DSN has no organization target", () => {
    mockSentryClient({
      dsn: {
        protocol: "https",
        host: "sentry.example.com",
        projectId: "4501",
      },
    });

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
