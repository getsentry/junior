import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PendingMailboxStack } from "../src/client/conversations/PendingMailboxStack";
import type { ConversationMailboxMessage } from "../src/client/conversations/conversationOutbox";

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
        messages={[message()]}
        onCancelMessage={() => undefined}
      />,
    );
    const localOnly = renderToStaticMarkup(
      <PendingMailboxStack
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
    expect(html).not.toContain("Could not remove. Try again.");
  });

  it("shows an inline remove error on the target accepted row", () => {
    const html = renderToStaticMarkup(
      <PendingMailboxStack
        cancelError
        cancelTargetInboundMessageId="accepted-1"
        messages={[message()]}
        onCancelMessage={() => undefined}
      />,
    );

    expect(html).toContain("Could not remove. Try again.");
    expect(html).toContain('aria-label="Could not remove. Try again."');
  });

  it("hides mailbox rows already present in committed history", () => {
    const html = renderToStaticMarkup(
      <PendingMailboxStack
        committedMessageIds={["accepted-1"]}
        messages={[message()]}
        onCancelMessage={() => undefined}
      />,
    );

    expect(html).toBe("");
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
        messages={messages}
        onCancelMessage={() => undefined}
      />,
    );

    expect(html).toContain("5 queued messages");
    expect(html).not.toContain("Show queued messages");
    expect(html.match(/5 queued messages/g)).toHaveLength(1);
  });
});
