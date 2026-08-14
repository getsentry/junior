import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConversationDetailReport } from "@sentry/junior/api/schema";

import { PendingMailboxStack } from "../src/client/conversations/PendingMailboxStack";
import type { ConversationMailboxMessage } from "../src/client/conversations/conversationOutbox";

function conversation(): ConversationDetailReport {
  return {
    annotations: [],
    conversationId: "local:web:pending-stack",
    cumulativeDurationMs: 0,
    displayTitle: "Pending stack",
    eventHistory: { status: "available" },
    events: [],
    generatedAt: new Date(0).toISOString(),
    isParticipant: true,
    lastProgressAt: new Date(0).toISOString(),
    lastSeenAt: new Date(0).toISOString(),
    startedAt: new Date(0).toISOString(),
    status: "active",
    surface: "api",
    visibility: "public",
  };
}

function message(
  overrides: Partial<ConversationMailboxMessage> = {},
): ConversationMailboxMessage {
  return {
    createdAt: new Date(1_000).toISOString(),
    delivery: "defer",
    inboundMessageId: "accepted-1",
    messageId: "accepted-1",
    receivedAt: new Date(1_000).toISOString(),
    role: "user",
    source: "web",
    text: "queued",
    ...overrides,
  };
}

describe("PendingMailboxStack remove control", () => {
  it("shows remove only for an accepted mailbox row", () => {
    const accepted = renderToStaticMarkup(
      <PendingMailboxStack
        conversation={conversation()}
        messages={[message()]}
        onCancelMessage={() => undefined}
      />,
    );
    const localOnly = renderToStaticMarkup(
      <PendingMailboxStack
        conversation={conversation()}
        messages={[
          message({
            clientStatus: "sending",
            inboundMessageId: "client:1",
            messageId: "client:1",
          }),
        ]}
        onCancelMessage={() => undefined}
      />,
    );

    expect(accepted).toContain("Remove queued message");
    expect(localOnly).not.toContain("Remove queued message");
  });

  it("keeps remove available for accepted rows while a local send is pending", () => {
    const html = renderToStaticMarkup(
      <PendingMailboxStack
        conversation={conversation()}
        messages={[
          message(),
          message({
            clientStatus: "sending",
            inboundMessageId: "client:2",
            messageId: "client:2",
          }),
        ]}
        onCancelMessage={() => undefined}
      />,
    );

    expect(html.match(/aria-label="Remove queued message"/g)).toHaveLength(1);
  });

  it("does not show remove for failed local outbox rows", () => {
    const html = renderToStaticMarkup(
      <PendingMailboxStack
        cancelError
        conversation={conversation()}
        messages={[
          message({
            clientStatus: "failed",
            idempotencyKey: "retry-1",
            inboundMessageId: "client:retry-1",
            messageId: "client:retry-1",
          }),
        ]}
        onCancelMessage={() => undefined}
      />,
    );

    expect(html).not.toContain("Remove queued message");
  });

  it("uses the queue count on the mobile expand control", () => {
    const messages = Array.from({ length: 5 }, (_, index) =>
      message({
        inboundMessageId: `accepted-${index + 1}`,
        messageId: `accepted-${index + 1}`,
        text: `queued ${index + 1}`,
      }),
    );
    const html = renderToStaticMarkup(
      <PendingMailboxStack
        conversation={conversation()}
        messages={messages}
        onCancelMessage={() => undefined}
      />,
    );

    expect(html).toContain("5 queued messages");
    expect(html).not.toContain("Show queued messages");
    expect(html.match(/5 queued messages/g)).toHaveLength(1);
  });
});
