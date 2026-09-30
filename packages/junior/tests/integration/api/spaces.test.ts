import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi } from "@/api";
import { spaceDetailReportSchema, spaceTreeReportSchema } from "@/api/schema";
import { appendConversationBrief } from "@/chat/briefs/store";
import { closeDb, getConversationStore, getDb } from "@/chat/db";
import {
  assignConversations,
  createSpace,
  mergeSpace,
} from "@/chat/spaces/store";
import { conversationBriefFixture } from "../../fixtures/conversation-brief";

async function recordConversation(
  conversationId: string,
  visibility: "public" | "private",
) {
  await getConversationStore().recordActivity({
    conversationId,
    destination: { platform: "local", conversationId },
    nowMs: Date.parse("2026-09-01T12:00:00.000Z"),
    source: "local",
    title: `Title ${conversationId}`,
    visibility,
  });
  await appendConversationBrief(getDb(), {
    conversationId,
    turnId: "turn-1",
    throughSeq: 1,
    content: conversationBriefFixture({ summary: `Summary ${conversationId}` }),
    searchText: "summary",
    modelId: "test-model",
  });
}

describe("spaces API", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("returns the tree and a forum view of one Space", async () => {
    const actor = { kind: "agent" as const };
    const sdks = await createSpace(getDb(), {
      name: "SDKs",
      description: "Client SDK work.",
      actor,
    });
    const javascript = await createSpace(getDb(), {
      name: "JavaScript",
      parentSpaceId: sdks.spaceId,
      actor,
    });
    const legacy = await createSpace(getDb(), { name: "JS", actor });
    await recordConversation("local:api-spaces:public", "public");
    await recordConversation("local:api-spaces:private", "private");
    await assignConversations(getDb(), {
      conversationIds: ["local:api-spaces:public", "local:api-spaces:private"],
      spaceId: legacy.spaceId,
      actor,
      pinned: true,
    });
    await mergeSpace(getDb(), {
      spaceId: legacy.spaceId,
      intoSpaceId: javascript.spaceId,
      actor,
    });

    const api = createJuniorApi();
    const treeResponse = await api.request("/api/spaces");
    expect(treeResponse.status).toBe(200);
    const tree = spaceTreeReportSchema.parse(await treeResponse.json());
    expect(
      tree.spaces.map((space) => [
        space.path.join(" › "),
        space.totalConversationCount,
      ]),
    ).toEqual([
      ["SDKs", 2],
      ["SDKs › JavaScript", 2],
    ]);

    // A merged id still opens the Space that absorbed it.
    const detailResponse = await api.request(`/api/spaces/${legacy.spaceId}`);
    expect(detailResponse.status).toBe(200);
    const detail = spaceDetailReportSchema.parse(await detailResponse.json());
    expect(detail.space.spaceId).toBe(javascript.spaceId);
    expect(detail.breadcrumbs).toEqual([
      { spaceId: sdks.spaceId, name: "SDKs" },
    ]);
    expect(detail.conversations).toEqual([
      expect.objectContaining({
        conversationId: "local:api-spaces:public",
        summary: "Summary local:api-spaces:public",
      }),
    ]);
    expect(detail.privateConversationCount).toBe(1);

    expect((await api.request("/api/spaces/missing")).status).toBe(404);
  });
});
