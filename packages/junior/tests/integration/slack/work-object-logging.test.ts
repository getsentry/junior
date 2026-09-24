import { afterEach, expect, it, vi } from "vitest";
import { registerLogRecordSink, type EmittedLogRecord } from "@/chat/logging";
import { sendSlackReply } from "@/chat/slack/reply";

afterEach(() => vi.unstubAllEnvs());

it("logs Work Object delivery metadata without annotation content", async () => {
  vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test-token");
  const records: EmittedLogRecord[] = [];
  const unregister = registerLogRecordSink((record) => {
    if (record.eventName.startsWith("slack.work_object.post."))
      records.push(record);
  });
  try {
    const timestamps = await sendSlackReply({
      channelId: "C123",
      threadTs: "1700000000.000001",
      conversationId: "slack:C123:1700000000.000001",
      text: "private message text",
      cards: [
        {
          kind: "object",
          plugin: "github",
          key: "private-object-key",
          label: "private label",
          title: "private title",
          objectType: "code_change",
          url: "https://example.com/private-object",
          status: "private status",
        },
      ],
    });
    expect(records.map((record) => record.eventName)).toEqual([
      "slack.work_object.post.started",
      "slack.work_object.post.accepted",
    ]);
    expect(records[1]?.attributes).toMatchObject({
      "app.slack.channel_id": "C123",
      "app.slack.thread_ts": "1700000000.000001",
      "app.slack.work_object.count": 1,
      "app.slack.work_object.entity_types": ["slack#/entities/item"],
      "app.slack.work_object.reference_types": ["annotation"],
      "messaging.message.id": timestamps[0],
      "app.slack.warning_count": 0,
      "app.slack.response_message_count": 0,
    });
    expect(JSON.stringify(records)).not.toContain("private");
    expect(JSON.stringify(records)).not.toContain("example.com");
    await sendSlackReply({
      channelId: "C123",
      conversationId: "slack:C123:1700000000.000001",
      text: "No Work Object here.",
    });
    expect(records).toHaveLength(2);
  } finally {
    unregister();
  }
});
