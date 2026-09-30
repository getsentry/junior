import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import {
  conversationDetailReportSchema,
  spaceDetailReportSchema,
  spaceTreeReportSchema,
} from "@/api/schema";
import { appendConversationBrief } from "@/chat/briefs/store";
import { closeDb, getConversationStore, getDb } from "@/chat/db";
import { setSpacesConfig } from "@/chat/spaces/registration";
import {
  assignConversations,
  createSpace,
  mergeSpace,
} from "@/chat/spaces/store";
import { conversationBriefFixture } from "../../fixtures/conversation-brief";
import { testViewer } from "../../fixtures/user";

async function recordConversation(
  conversationId: string,
  visibility: "public" | "private",
  repository: string,
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
    content: conversationBriefFixture({
      summary: `Summary ${conversationId}`,
      links: [
        {
          kind: "code_change",
          label: `${repository}#1`,
          url: `https://github.com/${repository}/pull/1`,
        },
        {
          kind: "code_change",
          label: `${repository}#2`,
          url: `https://github.com/${repository}/pull/2`,
        },
      ],
    }),
    searchText: "summary",
    modelId: "test-model",
  });
}

describe("spaces API", () => {
  afterEach(async () => {
    setSpacesConfig(undefined);
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
    setSpacesConfig({ enabled: true });
    await recordConversation(
      "local:api-spaces:public",
      "public",
      "getsentry/sentry-javascript",
    );
    await recordConversation(
      "local:api-spaces:private",
      "private",
      "getsentry/private-repo",
    );
    await assignConversations(getDb(), {
      conversationIds: ["local:api-spaces:public", "local:api-spaces:private"],
      spaceId: legacy.spaceId,
      actor,
      kind: "bug",
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
        displayTitle: "Title local:api-spaces:public",
        summary: "Summary local:api-spaces:public",
        kind: "bug",
      }),
    ]);
    expect(detail.privateConversationCount).toBe(1);
    // Facts come only from public Conversations, one count per Conversation.
    expect(detail.facts.repositories).toEqual([
      {
        name: "getsentry/sentry-javascript",
        url: "https://github.com/getsentry/sentry-javascript",
        conversationCount: 1,
      },
    ]);
    expect(detail.facts.kinds).toEqual([{ kind: "bug", conversationCount: 1 }]);

    // A Conversation links back to its Space path.
    const conversation = conversationDetailReportSchema.parse(
      await (
        await api.request("/api/conversations/local:api-spaces:public")
      ).json(),
    );
    expect(conversation.space).toEqual({
      spaceId: javascript.spaceId,
      name: "JavaScript",
      path: [
        { spaceId: sdks.spaceId, name: "SDKs" },
        { spaceId: javascript.spaceId, name: "JavaScript" },
      ],
    });

    // Starting a Conversation in a Space that does not exist fails first.
    const viewerApi = new Hono<JuniorApiEnv>();
    viewerApi.use("*", async (context, next) => {
      context.set("viewer", testViewer("person@example.com"));
      await next();
    });
    viewerApi.route("/", api);
    const created = await viewerApi.request("/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: "space-create",
        message: "hello",
        spaceId: "missing",
      }),
    });
    expect(created.status).toBe(400);

    expect((await api.request("/api/spaces/missing")).status).toBe(404);
  });
});
