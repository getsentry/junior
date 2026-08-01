import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi } from "@/api";
import { conversationDetailReportSchema } from "@/api/schema";
import {
  closeDb,
  getDb,
  getConversationEventStore,
  getConversationStore,
} from "@/chat/db";
import { createPluginAnnotations } from "@/chat/plugins/annotations";
import { readConversationDetail } from "@/api/conversations/detail";

describe("conversation detail API", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("returns newly appended events when refreshed", async () => {
    const conversationId = "internal:refreshed-detail";
    await getConversationStore().recordActivity({
      conversationId,
      nowMs: 1,
      source: "internal",
      title: "Refreshed conversation",
    });

    const app = createJuniorApi();
    const detailResponse = await app.request(
      `http://localhost/api/conversations/${conversationId}`,
    );
    const detail = conversationDetailReportSchema.parse(
      await detailResponse.json(),
    );
    expect(detail.events).toEqual([]);

    await getConversationEventStore().append(conversationId, [
      {
        createdAtMs: 2,
        data: {
          messageId: "first-message",
          role: "assistant",
          text: "first-message",
          type: "message",
        },
      },
      {
        createdAtMs: 3,
        data: {
          content: { costUsd: 0.0004, memories: [] },
          name: "memories_recalled",
          namespace: "memory",
          type: "structured_event",
          version: 1,
        },
      },
    ]);
    const refreshedResponse = await app.request(
      `http://localhost/api/conversations/${conversationId}`,
    );
    const refreshed = conversationDetailReportSchema.parse(
      await refreshedResponse.json(),
    );
    expect(refreshed.events.map((event) => event.seq)).toEqual([0]);
    expect(refreshed.auxiliaryCosts).toEqual({
      costUsd: 0.0004,
      operations: [
        {
          costUsd: 0.0004,
          events: 1,
          name: "memories_recalled",
          namespace: "memory",
        },
      ],
    });
  });

  it("only returns annotations to viewers with private-content access", async () => {
    const conversationId = "slack:C-private:annotated-detail";
    await getConversationStore().recordActivity({
      actor: {
        email: "Participant@Example.com",
        platform: "slack",
        slackUserId: "U-participant",
        teamId: "T-private",
      },
      conversationId,
      destination: {
        channelId: "C-private",
        platform: "slack",
        teamId: "T-private",
      },
      nowMs: 1,
      source: "slack",
      title: "Private annotated conversation",
      visibility: "private",
    });
    const annotations = createPluginAnnotations({
      conversationId,
      db: getDb(),
      plugin: "github",
    });
    await annotations.upsert({
      kind: "resource_link",
      key: "getsentry/junior#1081",
      label: "getsentry/junior #1081",
      status: "open",
      url: "https://github.com/getsentry/junior/pull/1081",
    });

    await expect(readConversationDetail(conversationId)).resolves.toMatchObject(
      {
        annotations: [],
        eventHistory: { status: "redacted" },
      },
    );
    await expect(
      readConversationDetail(conversationId, {
        verifiedViewerEmail: "participant@example.com",
      }),
    ).resolves.toMatchObject({
      annotations: [
        {
          key: "getsentry/junior#1081",
          kind: "resource_link",
          label: "getsentry/junior #1081",
          plugin: "github",
          status: "open",
          url: "https://github.com/getsentry/junior/pull/1081",
        },
      ],
      eventHistory: { status: "available" },
    });
  });
});
