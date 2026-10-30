import { describe, expect, it } from "vitest";

import {
  conversationOutboxMessageForSubmit,
  failConversationOutboxMessage,
  mailboxMessageFromOutbox,
  mergeConversationMailboxMessages,
  settleConversationOutboxMessages,
  splitInlineMailboxMessages,
  upsertConversationOutboxMessage,
} from "../src/client/conversations/conversationOutbox";

describe("conversation outbox", () => {
  it("builds a sending row for one submit", () => {
    expect(
      conversationOutboxMessageForSubmit({
        idempotencyKey: "attempt-1",
        messageId: "accepted-1",
        message: "Continue in Junior",
        now: "2026-01-01T00:00:00.000Z",
      }),
    ).toEqual({
      createdAt: "2026-01-01T00:00:00.000Z",
      idempotencyKey: "attempt-1",
      messageId: "accepted-1",
      message: "Continue in Junior",
      status: "sending",
    });
  });

  it("keeps failed outbox rows in the mailbox after accept fails", () => {
    const outbox = [
      conversationOutboxMessageForSubmit({
        idempotencyKey: "attempt-1",
        messageId: "accepted-1",
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

  it("reuses the same outbox slot when retrying a failed send", () => {
    const failed = failConversationOutboxMessage(
      [
        conversationOutboxMessageForSubmit({
          idempotencyKey: "attempt-1",
          messageId: "accepted-1",
          message: "Continue in Junior",
          now: "2026-01-01T00:00:00.000Z",
        }),
      ],
      "attempt-1",
    );
    const retry = conversationOutboxMessageForSubmit({
      idempotencyKey: "attempt-1",
      messageId: "accepted-1",
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
          messageId: "accepted-2",
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

  it("shows inline sends in the transcript until a failure moves them to the queue", () => {
    const inline = conversationOutboxMessageForSubmit({
      idempotencyKey: "attempt-1",
      inline: true,
      messageId: "accepted-1",
      message: "Continue in Junior",
      now: "2026-01-01T00:00:00.000Z",
    });
    const server = [
      {
        ...mailboxMessageFromOutbox(inline),
        clientStatus: undefined,
        idempotencyKey: undefined,
        actorIdentity: { fullName: "Morgan Lee" },
      },
    ];
    // The server copy wins, but it stays out of the queue.
    expect(
      splitInlineMailboxMessages(
        mergeConversationMailboxMessages(server, [inline]),
        server,
        [inline],
      ),
    ).toEqual({ inline: server, queued: [] });

    const failed = failConversationOutboxMessage([inline], "attempt-1");
    const merged = mergeConversationMailboxMessages([], failed);
    expect(splitInlineMailboxMessages(merged, [], failed)).toEqual({
      inline: [],
      queued: merged,
    });
  });

  it("keeps inline sends until history reads them or the queue drops them", () => {
    const accepted = (messageId: string, message: string) => ({
      ...conversationOutboxMessageForSubmit({
        idempotencyKey: messageId,
        inline: true,
        messageId,
        message,
        now: "2026-01-01T00:00:00.000Z",
      }),
      acceptedAtMs: 1_000,
      status: "accepted" as const,
    });
    const serverCopy = (message: ReturnType<typeof accepted>) => ({
      ...mailboxMessageFromOutbox(message),
      clientStatus: undefined,
      idempotencyKey: undefined,
    });
    const inline = accepted("accepted-1", "Continue in Junior");
    const joined = accepted("accepted-2", "And the rollback owner");
    const queuedRow = { ...accepted("queued-1", "Queued"), inline: undefined };
    const outbox = [inline, joined, queuedRow];

    // A mailbox read from before the accept proves nothing. The queued row
    // leaves once the mailbox lists it.
    expect(
      settleConversationOutboxMessages(outbox, {
        events: [],
        mailboxReadAtMs: 900,
        queued: [serverCopy(queuedRow)],
      }),
    ).toEqual([inline, joined]);

    // A Turn joined the second send into the first Message, so only its
    // started event has the second id. The Turn starts before the mailbox
    // drops the send, so the row stays inline and out of the queue.
    const turnStarted = [
      {
        seq: 1,
        createdAt: "2026-01-01T00:00:02.000Z",
        data: {
          type: "turn_lifecycle" as const,
          turnId: "turn-1",
          state: "started" as const,
          inputMessageIds: ["accepted-1", "accepted-2"],
        },
      },
      {
        seq: 2,
        createdAt: "2026-01-01T00:00:02.000Z",
        data: {
          type: "message" as const,
          messageId: "accepted-1",
          role: "user" as const,
          text: "Continue in Junior\nAnd the rollback owner",
        },
      },
    ];
    const server = [serverCopy(inline), serverCopy(joined)];
    const whileQueued = settleConversationOutboxMessages([inline, joined], {
      events: turnStarted,
      mailboxReadAtMs: 2_000,
      queued: server,
    });
    expect(whileQueued).toEqual([joined]);
    const split = splitInlineMailboxMessages(
      mergeConversationMailboxMessages(server, whileQueued),
      server,
      whileQueued,
    );
    expect(split.inline.map((message) => message.messageId)).toEqual([
      "accepted-2",
    ]);
    expect(split.queued.map((message) => message.messageId)).toEqual([
      "accepted-1",
    ]);
    // History has a Message for the first send, so the queue hides it.

    // After the ack, the Turn input id settles the joined send.
    expect(
      settleConversationOutboxMessages([joined], {
        events: turnStarted,
        mailboxReadAtMs: 3_000,
        queued: [],
      }),
    ).toEqual([]);

    // A mailbox read after the accept has neither copy: someone removed it.
    const unchanged = [inline];
    expect(
      settleConversationOutboxMessages(unchanged, {
        events: [],
        mailboxReadAtMs: 1_000,
        queued: [],
      }),
    ).toBe(unchanged);
    expect(
      settleConversationOutboxMessages(unchanged, {
        events: [],
        mailboxReadAtMs: 1_001,
        queued: [],
      }),
    ).toEqual([]);
  });
});
