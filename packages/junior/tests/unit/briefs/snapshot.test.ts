import { describe, expect, it } from "vitest";
import { generateBrief } from "@/chat/briefs/generate";
import {
  briefInputFromSnapshot,
  createConversationSnapshot,
} from "@/chat/briefs/snapshot";
import type {
  ConversationDetailReport,
  ConversationEventPage,
} from "@/api/schema/conversation";

const detail: ConversationDetailReport = {
  displayTitle: "Release follow-up",
  cumulativeDurationMs: 100,
  conversationId: "conversation-1",
  isParticipant: true,
  visibility: "public",
  status: "completed",
  startedAt: "2026-01-01T00:00:00.000Z",
  lastSeenAt: "2026-01-01T00:00:04.000Z",
  lastProgressAt: "2026-01-01T00:00:04.000Z",
  surface: "slack",
  channelName: "builds",
  annotations: [
    {
      kind: "resource_link",
      key: "incident-1",
      label: "Release incident",
      url: "https://sentry.example.com/issues/1",
      status: "warning",
      plugin: "sentry",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  events: [
    {
      seq: 3,
      createdAt: "2026-01-01T00:00:02.000Z",
      data: {
        type: "tool_calls",
        calls: [
          {
            toolCallId: "tool-1",
            name: "lookupRelease",
            status: "completed",
            output: { version: "1.2.3" },
          },
        ],
      },
    },
    {
      seq: 4,
      createdAt: "2026-01-01T00:00:03.000Z",
      data: {
        type: "message",
        messageId: "assistant-1",
        role: "assistant",
        text: "Released version 1.2.3.",
      },
    },
    {
      seq: 5,
      createdAt: "2026-01-01T00:00:04.000Z",
      data: {
        type: "turn_lifecycle",
        turnId: "turn-1",
        state: "succeeded",
      },
    },
  ],
  eventHistory: { status: "available" },
  generatedAt: "2026-01-01T00:00:05.000Z",
};

const olderPage: ConversationEventPage = {
  events: [
    {
      seq: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      data: {
        type: "message",
        messageId: "message-1",
        role: "user",
        text: "Ship version 1.2.3.",
        actorIdentity: { fullName: "Ada Lovelace" },
      },
    },
    {
      seq: 2,
      createdAt: "2026-01-01T00:00:01.000Z",
      data: {
        type: "turn_lifecycle",
        turnId: "turn-1",
        state: "started",
        inputMessageIds: ["message-1"],
      },
    },
  ],
  eventHistory: { status: "available" },
  generatedAt: "2026-01-01T00:00:05.000Z",
};

describe("Brief snapshot", () => {
  it("projects detail and event pages into a deterministic Brief record", async () => {
    const snapshot = createConversationSnapshot({
      detail,
      eventPages: [olderPage],
      pulledAt: "2026-01-01T00:00:06.000Z",
      codeChanges: [
        {
          repository: "getsentry/junior",
          number: 42,
          title: "Ship 1.2.3",
          url: "https://github.com/getsentry/junior/pull/42",
          state: "merged",
          openedAt: "2025-12-31T23:00:00.000Z",
          mergedAt: "2026-01-01T00:00:04.000Z",
        },
      ],
    });

    const input = briefInputFromSnapshot(snapshot);
    expect(input).toMatchInlineSnapshot(`
      {
        "codeChanges": [
          {
            "mergedAt": "2026-01-01T00:00:04.000Z",
            "number": 42,
            "openedAt": "2025-12-31T23:00:00.000Z",
            "repository": "getsentry/junior",
            "state": "merged",
            "title": "Ship 1.2.3",
            "url": "https://github.com/getsentry/junior/pull/42",
          },
        ],
        "conversationId": "conversation-1",
        "entries": [
          {
            "author": "Ada Lovelace",
            "createdAtMs": 1767225600000,
            "index": 1,
            "role": "user",
            "text": "Ship version 1.2.3.",
            "turnId": "turn-1",
          },
          {
            "author": "lookupRelease",
            "createdAtMs": 1767225602000,
            "index": 3,
            "role": "tool",
            "text": "{
        "version": "1.2.3"
      }",
            "turnId": "turn-1",
          },
          {
            "createdAtMs": 1767225603000,
            "index": 4,
            "role": "assistant",
            "text": "Released version 1.2.3.",
            "turnId": "turn-1",
          },
        ],
        "location": {
          "channelName": "builds",
          "provider": "slack",
        },
        "resources": [
          {
            "label": "Release incident",
            "status": "warning",
            "url": "https://sentry.example.com/issues/1",
          },
        ],
        "title": "Release follow-up",
        "visibility": "public",
      }
    `);

    const generation = await generateBrief({
      input,
      throughIndex: 5,
      prompt: "Write a Brief.",
      model: "test/model",
      completeObject: async () => ({
        object: {
          summary: "Version 1.2.3 was released.",
          intent: "Ship version 1.2.3.",
          outcome: { status: "done", text: "The release is complete." },
          decisions: [],
          openDecisions: [],
          facts: ["The version is 1.2.3."],
          keywords: ["release"],
          urls: [],
        },
      }),
    });

    expect(generation.brief.record).toEqual({
      startedAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: "2026-01-01T00:00:03.000Z",
      durationMs: 3_000,
      participants: [{ name: "Ada Lovelace", messages: 1 }],
      userMessages: 1,
      assistantMessages: 1,
      toolResults: 1,
      turns: 1,
      location: { provider: "slack", channelName: "builds" },
      codeChanges: [
        {
          repository: "getsentry/junior",
          number: 42,
          title: "Ship 1.2.3",
          url: "https://github.com/getsentry/junior/pull/42",
          state: "merged",
          openedAt: "2025-12-31T23:00:00.000Z",
          mergedAt: "2026-01-01T00:00:04.000Z",
        },
      ],
    });
  });
});
