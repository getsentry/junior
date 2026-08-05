import { describe, expect, it } from "vitest";
import { resolveConversationPrivacy } from "@/chat/conversation-privacy";
import { registerLogRecordSink, type EmittedLogRecord } from "@/chat/logging";

describe("conversation visibility logging", () => {
  it.each(["public", "private", "direct", "unknown"] as const)(
    "does not warn for confirmed %s visibility",
    (visibility) => {
      const records: EmittedLogRecord[] = [];
      const unregister = registerLogRecordSink((record) => {
        records.push(record);
      });

      try {
        resolveConversationPrivacy({ visibility });
      } finally {
        unregister();
      }

      expect(records).toEqual([]);
    },
  );

  it("warns when visibility is missing", () => {
    const records: EmittedLogRecord[] = [];
    const unregister = registerLogRecordSink((record) => {
      records.push(record);
    });

    try {
      resolveConversationPrivacy({});
    } finally {
      unregister();
    }

    expect(records).toEqual([
      expect.objectContaining({
        eventName: "conversation.visibility.defaulted",
        level: "warn",
      }),
    ]);
  });
});
