import { describe, expect, it } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import {
  legacyActorProvenance,
  readSessionLogEntries,
  type SessionLogEntry,
  type SessionLogStore,
} from "@/cli/upgrade/migrations/conversation-history/session-log";

function userMessage(text: string): PiMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 1,
  } as PiMessage;
}

function memoryStore(values: unknown[]): SessionLogStore {
  return {
    read: async () => values as SessionLogEntry[],
  };
}

describe("operator legacy session log decode", () => {
  it("preserves ordered legacy entry discriminants for the SQL importer", async () => {
    const message = userMessage("legacy question");
    const values = [
      {
        schemaVersion: 2,
        type: "pi_message",
        sessionId: "session_0",
        message,
      },
      {
        schemaVersion: 2,
        type: "projection_reset",
        sessionId: "session_1",
        messages: [message],
        provenance: [{ authority: "context" }],
      },
      {
        schemaVersion: 2,
        type: "mcp_provider_connected",
        sessionId: "session_1",
        provider: "github",
      },
      {
        schemaVersion: 2,
        type: "tool_execution_started",
        sessionId: "session_1",
        createdAtMs: 2,
        toolCallId: "legacy-tool-call",
        toolName: "legacy-tool",
        args: { token: "legacy-sensitive-token" },
      },
    ];

    await expect(
      readSessionLogEntries({
        conversationId: "legacy-conversation",
        store: memoryStore(values),
      }),
    ).resolves.toEqual(values);
  });

  it("wraps a pre-envelope Pi message in the legacy wire format", async () => {
    const message = userMessage("raw legacy message");

    await expect(
      readSessionLogEntries({
        conversationId: "legacy-conversation",
        store: memoryStore([message]),
      }),
    ).resolves.toEqual([
      {
        schemaVersion: 2,
        type: "pi_message",
        sessionId: "session_0",
        message,
      },
    ]);
  });

  it("decodes JSON strings and migrates requester fields", async () => {
    const message = userMessage("authored legacy message");
    const requester = {
      platform: "slack",
      slackUserId: "U123",
      slackUserName: "alice",
      teamId: "T123",
    };

    await expect(
      readSessionLogEntries({
        conversationId: "legacy-conversation",
        store: memoryStore([
          JSON.stringify({
            schemaVersion: 1,
            type: "pi_message",
            message,
            requester,
          }),
          {
            schemaVersion: 1,
            type: "requester_recorded",
            requester,
          },
        ]),
      }),
    ).resolves.toEqual([
      {
        schemaVersion: 1,
        type: "pi_message",
        sessionId: "session_0",
        message,
        actor: requester,
      },
      {
        schemaVersion: 1,
        type: "actor_recorded",
        sessionId: "session_0",
        actor: requester,
      },
    ]);
  });

  it("rejects malformed legacy entries at the decode boundary", async () => {
    await expect(
      readSessionLogEntries({
        conversationId: "legacy-conversation",
        store: memoryStore([{ type: "unknown_legacy_entry" }]),
      }),
    ).rejects.toThrow("Invalid input");
  });
});

describe("legacyActorProvenance", () => {
  it("recovers an instruction actor when identity fields are intact", () => {
    expect(
      legacyActorProvenance({
        platform: "slack",
        slackUserId: "U123",
        slackUserName: "alice",
        teamId: "T123",
      }),
    ).toEqual({
      authority: "instruction",
      actor: {
        platform: "slack",
        teamId: "T123",
        userId: "U123",
        userName: "alice",
      },
    });
  });

  it("fails closed to ambient context when identity is incomplete", () => {
    expect(
      legacyActorProvenance({
        platform: "slack",
        slackUserId: "U123",
      }),
    ).toEqual({ authority: "context" });
  });
});
