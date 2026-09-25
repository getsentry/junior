import { createMemoryState } from "@chat-adapter/state-memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleSlackWebhook } from "@/chat/ingress/slack-webhook";
import { slackMessageAttributes } from "@/chat/ingress/slack-message-telemetry";
import { slackEventEnvelopeSchema } from "@/chat/ingress/slack-payload";
import {
  createConversationWorkQueueTestAdapter,
  createNoopSlackWebhookRuntime,
  createSlackAdapterFixture,
  slackWebhookRequest,
} from "../../fixtures/conversation-work";
import { slackEventsApiEnvelope } from "../../fixtures/slack/factories/events";

const { span, startSpan } = vi.hoisted(() => {
  const span = { setAttribute: vi.fn(), setStatus: vi.fn() };
  return {
    span,
    startSpan: vi.fn(
      async (_options: unknown, callback: (value: typeof span) => unknown) =>
        callback(span),
    ),
  };
});

vi.mock("@/chat/sentry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/sentry")>()),
  startSpan,
  getActiveSpan: () => span,
}));

afterEach(() => vi.clearAllMocks());

describe("Slack inbound telemetry", () => {
  it("records author and installation fields before rejecting an external author", async () => {
    const state = createMemoryState();
    await state.connect();
    try {
      const envelope = slackEventsApiEnvelope({ user: "U123" });
      // External mention fields: Bolt tests/slack_bolt/request/test_internals.py#L717-L744
      // https://github.com/slackapi/bolt-python/blob/eddc4766559e5dc623700015c70ea360d076dced/tests/slack_bolt/request/test_internals.py#L717-L744
      const response = await handleSlackWebhook({
        request: slackWebhookRequest({
          ...envelope,
          event_id: "Ev123",
          is_ext_shared_channel: true,
          event: {
            ...envelope.event,
            team: "T123",
            user_team: "TEXTERNAL",
            source_team: "TEXTERNAL",
          },
        }),
        services: {
          getSlackAdapter: createSlackAdapterFixture,
          state,
          queue: createConversationWorkQueueTestAdapter(),
          runtime: createNoopSlackWebhookRuntime(),
        },
        waitUntil: () => {},
      });
      expect(response.status).toBe(200);
      expect(startSpan).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "slack.message.ingress",
          op: "slack.message.ingress",
          attributes: expect.objectContaining({
            "enduser.id": "U123",
            "app.slack.user_id": "U123",
            "app.slack.team_id": "T123",
            "app.slack.user_team": "TEXTERNAL",
            "app.slack.source_team": "TEXTERNAL",
            "app.slack.event_team": "T123",
            "app.slack.event_id": "Ev123",
            "app.slack.is_ext_shared_channel": true,
            "messaging.message.id": envelope.event.ts,
            "gen_ai.conversation.id": `slack:${envelope.event.channel}:${envelope.event.ts}`,
          }),
        }),
        expect.any(Function),
      );
      expect(span.setAttribute).toHaveBeenCalledWith(
        "app.slack.membership",
        "unverified",
      );
    } finally {
      await state.disconnect();
    }
  });

  it("keeps missing fields distinct from invalid input without recording content", () => {
    const envelope = slackEventsApiEnvelope();
    const absent = slackMessageAttributes(
      slackEventEnvelopeSchema.parse(envelope),
    );
    expect(absent["app.slack.user_team"]).toBe("missing");
    expect(absent["app.slack.source_team"]).toBe("missing");
    expect(absent["app.slack.is_ext_shared_channel"]).toBe("missing");

    const attributes = slackMessageAttributes(
      slackEventEnvelopeSchema.parse({
        ...envelope,
        event_id: { text: "private content" },
        is_ext_shared_channel: "private content",
        event: {
          ...envelope.event,
          text: "private content",
          username: "private name",
          user_team: "private content",
          source_team: "E123",
          bot_id: "B123",
        },
      }),
    );
    expect(attributes).toEqual({
      "messaging.message.id": envelope.event.ts,
      "app.slack.event_id": "invalid",
      "app.slack.event_type": "app_mention",
      "app.slack.event_subtype": "missing",
      "app.slack.user_id": "U0TEST",
      "app.slack.bot_id": "B123",
      "app.slack.team_id": "T123",
      "app.slack.enterprise_id": "missing",
      "app.slack.user_team": "invalid",
      "app.slack.source_team": "E123",
      "app.slack.event_team": "missing",
      "app.slack.is_ext_shared_channel": "invalid",
    });
  });
});
