import { describe, expect, it } from "vitest";

import {
  conversationOutboxMessageForSubmit,
  failConversationOutboxMessage,
  mailboxMessageFromOutbox,
  mergeConversationMailboxMessages,
  removeConversationOutboxMessage,
  upsertConversationOutboxMessage,
} from "../src/client/conversations/conversationOutbox";

describe("conversation outbox", () => {
  it("builds a sending row for one submit", () => {
    expect(
      conversationOutboxMessageForSubmit({
        idempotencyKey: "attempt-1",
        message: "Continue in Junior",
        now: "2026-01-01T00:00:00.000Z",
      }),
    ).toEqual({
      createdAt: "2026-01-01T00:00:00.000Z",
      idempotencyKey: "attempt-1",
      message: "Continue in Junior",
      messageId: "client:attempt-1",
      status: "sending",
    });
  });

  it("keeps failed outbox rows in the mailbox after accept fails", () => {
    const outbox = [
      conversationOutboxMessageForSubmit({
        idempotencyKey: "attempt-1",
        message: "Continue in Junior",
        now: "2026-01-01T00:00:00.000Z",
      }),
    ];
    const failed = failConversationOutboxMessage(outbox, "attempt-1");
    expect(mergeConversationMailboxMessages([], failed)).toEqual([
      mailboxMessageFromOutbox({
        ...outbox[0]!,
        status: "failed",
      }),
    ]);
  });

  it("drops an outbox row once the accept request succeeds", () => {
    const outbox = [
      conversationOutboxMessageForSubmit({
        idempotencyKey: "attempt-1",
        message: "Continue in Junior",
      }),
    ];
    expect(removeConversationOutboxMessage(outbox, "attempt-1")).toEqual([]);
  });

  it("reuses the same outbox slot when retrying a failed send", () => {
    const failed = failConversationOutboxMessage(
      [
        conversationOutboxMessageForSubmit({
          idempotencyKey: "attempt-1",
          message: "Continue in Junior",
          now: "2026-01-01T00:00:00.000Z",
        }),
      ],
      "attempt-1",
    );
    const retry = conversationOutboxMessageForSubmit({
      idempotencyKey: "attempt-1",
      message: "Continue in Junior",
      now: "2026-01-01T00:00:05.000Z",
    });
    expect(upsertConversationOutboxMessage(failed, retry)).toEqual([retry]);
  });

  it("keeps mailbox list identity across identical live polls", () => {
    const server = [
      {
        createdAt: "2026-01-01T00:00:00.000Z",
        delivery: "defer" as const,
        inboundMessageId: "accepted-1",
        messageId: "accepted-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
        role: "user" as const,
        source: "web" as const,
        text: "queued",
      },
    ];
    const first = mergeConversationMailboxMessages(server, []);
    const second = mergeConversationMailboxMessages(
      [{ ...server[0]! }],
      [],
      first,
    );
    expect(second).toBe(first);
  });

  it("returns a new mailbox list when outbox content changes", () => {
    const server = [
      {
        createdAt: "2026-01-01T00:00:00.000Z",
        delivery: "defer" as const,
        inboundMessageId: "accepted-1",
        messageId: "accepted-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
        role: "user" as const,
        source: "web" as const,
        text: "queued",
      },
    ];
    const first = mergeConversationMailboxMessages(server, []);
    const second = mergeConversationMailboxMessages(
      server,
      [
        conversationOutboxMessageForSubmit({
          idempotencyKey: "attempt-2",
          message: "next",
          now: "2026-01-01T00:00:01.000Z",
        }),
      ],
      first,
    );
    expect(second).not.toBe(first);
    expect(second).toHaveLength(2);
  });

  it("returns a new mailbox list when actor identity is enriched", () => {
    const first = mergeConversationMailboxMessages(
      [
        {
          createdAt: "2026-01-01T00:00:00.000Z",
          delivery: "defer",
          inboundMessageId: "accepted-1",
          messageId: "accepted-1",
          receivedAt: "2026-01-01T00:00:00.000Z",
          role: "user",
          source: "slack",
          text: "queued",
        },
      ],
      [],
    );
    const second = mergeConversationMailboxMessages(
      [
        {
          actorIdentity: {
            fullName: "Morgan Lee",
            slackUserName: "morgan",
          },
          createdAt: "2026-01-01T00:00:00.000Z",
          delivery: "defer",
          inboundMessageId: "accepted-1",
          messageId: "accepted-1",
          receivedAt: "2026-01-01T00:00:00.000Z",
          role: "user",
          source: "slack",
          text: "queued",
        },
      ],
      [],
      first,
    );
    expect(second).not.toBe(first);
    expect(second[0]?.actorIdentity?.fullName).toBe("Morgan Lee");
  });
});
