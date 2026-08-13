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

describe("PendingMailboxStack cancel control", () => {
  it("shows cancel only when an accepted mailbox row exists", () => {
    const accepted = renderToStaticMarkup(
      <PendingMailboxStack
        conversation={conversation()}
        messages={[message()]}
        onCancelQueue={() => undefined}
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
        onCancelQueue={() => undefined}
      />,
    );

    expect(accepted).toContain("Cancel queue");
    expect(localOnly).not.toContain("Cancel queue");
  });

  it("hides a stale cancel error when only local outbox rows remain", () => {
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
        onCancelQueue={() => undefined}
      />,
    );

    expect(html).not.toContain("Could not cancel queued messages");
  });
});
