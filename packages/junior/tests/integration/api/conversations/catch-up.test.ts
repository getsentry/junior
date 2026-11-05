import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import { conversationCatchUpSchema } from "@/api/schema";
import { appendConversationBrief } from "@/chat/briefs/store";
import {
  closeDb,
  getConversationEventStore,
  getConversationStore,
  getDb,
} from "@/chat/db";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { conversationBriefFixture } from "../../../fixtures/conversation-brief";
import {
  mockTitleModel,
  type TitleModelRequest,
} from "../../../fixtures/title-model";

async function authenticatedApi(email: string) {
  const viewer = await resolveViewerUser(email);
  if (!viewer) throw new Error(`missing viewer for ${email}`);
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  return app;
}

async function seedConversation(
  conversationId: string,
  visibility?: "public",
): Promise<void> {
  await getConversationStore().recordActivity({
    destination: { platform: "local" as const, conversationId },
    conversationId,
    nowMs: 1_000,
    source: "internal",
    title: "Login fix",
    ...(visibility ? { visibility } : undefined),
  });
  const messages = [
    ["user", "Please open a PR for the login fix."],
    ["assistant", "I opened PR #12 for the login fix."],
    ["user", "CI failed on Safari. Can the reader review the new patch?"],
    ["assistant", "I pushed a Safari fix to PR #12. It waits on review."],
  ] as const;
  await getConversationEventStore().append(
    conversationId,
    messages.map(([role, text], index) => ({
      createdAtMs: 2_000 + index,
      data: { messageId: `message-${index}`, role, text, type: "message" },
    })),
  );
  // The reader stopped after seq 1, so they saw the first Brief only.
  for (const [throughSeq, summary] of [
    [1, "Junior opened PR #12 for the login fix."],
    [3, "A later Brief that the reader has not seen."],
  ] as const) {
    await appendConversationBrief(getDb(), {
      conversationId,
      turnId: `turn-${throughSeq}`,
      throughSeq,
      content: conversationBriefFixture({ summary }),
      searchText: summary,
      modelId: "test-model",
    });
  }
}

function postCatchUp(
  app: Hono<JuniorApiEnv>,
  conversationId: string,
  body: unknown,
) {
  return app.request(
    `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/catch-up`,
    {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
}

describe("conversation catch-up API", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("summarizes rows after the read position with the Brief the reader saw", async () => {
    const conversationId = "local:test:catch-up";
    await seedConversation(conversationId, "public");
    const requests: TitleModelRequest[] = [];
    mockTitleModel(
      "CI failed on Safari, and Junior pushed a fix to PR #12.\nNeeds you: review the Safari fix on PR #12.",
      { onRequest: (request) => requests.push(request) },
    );
    const app = await authenticatedApi("reader@example.com");

    const response = await postCatchUp(app, conversationId, {
      afterSeq: 1,
      throughSeq: 3,
    });

    expect(response.status).toBe(200);
    expect(conversationCatchUpSchema.parse(await response.json())).toEqual({
      needsYou: "review the Safari fix on PR #12.",
      summary: "CI failed on Safari, and Junior pushed a fix to PR #12.",
    });
    expect(requests).toHaveLength(1);
    const prompt = JSON.stringify(requests[0]!.messages);
    expect(prompt).toContain("Junior opened PR #12 for the login fix.");
    expect(prompt).toContain("CI failed on Safari.");
    expect(prompt).toContain("I pushed a Safari fix to PR #12.");
    expect(prompt).not.toContain("Please open a PR for the login fix.");
    expect(prompt).not.toContain("A later Brief that the reader has not seen.");
  });

  it("rejects readers who cannot see the transcript and empty ranges", async () => {
    const privateId = "local:test:catch-up-private";
    await seedConversation(privateId);
    const publicId = "local:test:catch-up-empty";
    await seedConversation(publicId, "public");
    const app = await authenticatedApi("outsider@example.com");

    expect(
      (await postCatchUp(app, privateId, { afterSeq: 1, throughSeq: 3 }))
        .status,
    ).toBe(403);
    expect(
      (await postCatchUp(app, publicId, { afterSeq: 3, throughSeq: 3 })).status,
    ).toBe(400);
    expect(
      (await postCatchUp(app, publicId, { afterSeq: 3, throughSeq: 9 })).status,
    ).toBe(404);
    expect(
      (
        await postCatchUp(createJuniorApi(), publicId, {
          afterSeq: 1,
          throughSeq: 3,
        })
      ).status,
    ).toBe(401);
  });
});
