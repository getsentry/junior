import { describe, expect, it } from "vitest";
import { slackEventsApiEnvelope } from "../../fixtures/slack/factories/events";
import { extractSlackChannelMessageCreatedEnvelope } from "@/chat/events/slack";

describe("Slack event prompt envelopes", () => {
  it("extracts root channel messages", () => {
    const envelope = extractSlackChannelMessageCreatedEnvelope(
      slackEventsApiEnvelope({
        eventType: "message",
        channel: "C123",
        ts: "1700000000.000001",
        text: "deploy started",
        user: "U123",
      }),
      { botUserId: "U_BOT" },
    );

    expect(envelope).toMatchObject({
      event: "slack.channel.message.created",
      sourceEventId: "Ev_TEST",
      actor: {
        id: "U123",
        type: "slack_user",
      },
      scope: {
        teamId: "T_TEST",
        channelId: "C123",
      },
      payload: {
        actor: "U123",
        channelId: "C123",
        messageTs: "1700000000.000001",
        text: "deploy started",
        userId: "U123",
      },
    });
  });

  it("ignores thread replies, DMs, MPIMs, and bot-authored messages", () => {
    expect(
      extractSlackChannelMessageCreatedEnvelope(
        slackEventsApiEnvelope({
          eventType: "message",
          channel: "C123",
          ts: "1700000000.000002",
          threadTs: "1700000000.000001",
        }),
        { botUserId: "U_BOT" },
      ),
    ).toBeUndefined();

    expect(
      extractSlackChannelMessageCreatedEnvelope(
        slackEventsApiEnvelope({
          eventType: "message",
          channel: "D123",
        }),
        { botUserId: "U_BOT" },
      ),
    ).toBeUndefined();

    expect(
      extractSlackChannelMessageCreatedEnvelope(
        slackEventsApiEnvelope({
          eventType: "message",
          channel: "G123",
          channelType: "mpim",
        }),
        { botUserId: "U_BOT" },
      ),
    ).toBeUndefined();

    expect(
      extractSlackChannelMessageCreatedEnvelope(
        slackEventsApiEnvelope({
          eventType: "message",
          channel: "C123",
          user: "U_BOT",
        }),
        { botUserId: "U_BOT" },
      ),
    ).toBeUndefined();
  });

  it("requires the bot user id before accepting root messages", () => {
    expect(
      extractSlackChannelMessageCreatedEnvelope(
        slackEventsApiEnvelope({
          eventType: "message",
          channel: "C123",
          text: "deploy started",
          user: "U123",
        }),
        { botUserId: "" },
      ),
    ).toBeUndefined();
  });

  it("ignores messages that directly mention the bot", () => {
    expect(
      extractSlackChannelMessageCreatedEnvelope(
        slackEventsApiEnvelope({
          eventType: "message",
          channel: "C123",
          text: "<@U_BOT> can you look at this?",
          user: "U123",
        }),
        { botUserId: "U_BOT" },
      ),
    ).toBeUndefined();
  });
});
