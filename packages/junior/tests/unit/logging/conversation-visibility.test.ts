import { describe, expect, it } from "vitest";
import { resolveConversationPrivacy } from "@/chat/conversation-privacy";
import { registerLogRecordSink, type EmittedLogRecord } from "@/chat/logging";

describe("conversation visibility logging", () => {
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
