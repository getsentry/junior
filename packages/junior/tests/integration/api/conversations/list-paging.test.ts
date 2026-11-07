import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { User } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi } from "@/api";
import { readConversationFeedFromSql } from "@/api/conversations/list";
import type { JuniorApiEnv } from "@/api/route";
import { apiErrorSchema } from "@/api/schema";
import { setDashboardConversationLinkOptions } from "@/chat/dashboard-link";
import { closeDb, getConversationStore, getDb } from "@/chat/db";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { juniorConversationParticipants } from "@/db/schema";

async function storeViewerConversation(
  conversationId: string,
  nowMs: number,
  userId: string,
) {
  await getConversationStore().recordActivity({
    conversationId,
    destination: { platform: "local", conversationId },
    nowMs,
    source: "internal",
    title: conversationId,
    visibility: "private",
  });
  await getDb()
    .insert(juniorConversationParticipants)
    .values({
      lastMessageAt: new Date(nowMs),
      rootConversationId: conversationId,
      userId,
    });
}

/** Follow `nextCursor` one row at a time and return the ids in page order. */
async function readEveryPage(viewer: User): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await readConversationFeedFromSql({
      ...(cursor ? { cursor } : undefined),
      limit: 1,
      viewer,
    });
    ids.push(...page.conversations.map((item) => item.conversationId));
    cursor = page.nextCursor;
  } while (cursor && ids.length < 10);
  return ids;
}

describe("conversation list paging", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("pages with a signed cursor across pins and returns dashboard links", async () => {
    const previousLinkOptions = setDashboardConversationLinkOptions({
      baseURL: "https://junior.example.com",
      basePath: "/dashboard",
    });
    try {
      const viewer = await resolveViewerUser("pager@example.com");
      if (!viewer) throw new Error("missing viewer");
      await storeViewerConversation("local:page:oldest", 1_000, viewer.id);
      // Two roots with the same activity time must sort by id.
      await storeViewerConversation("local:page:tie-b", 2_000, viewer.id);
      await storeViewerConversation("local:page:tie-a", 2_000, viewer.id);
      await storeViewerConversation("local:page:newest", 3_000, viewer.id);

      const firstPage = await readConversationFeedFromSql({ limit: 1, viewer });
      expect(firstPage.conversations).toEqual([
        expect.objectContaining({
          dashboardUrl:
            "https://junior.example.com/dashboard/conversations/local%3Apage%3Anewest",
        }),
      ]);
      await expect(readEveryPage(viewer)).resolves.toEqual([
        "local:page:newest",
        "local:page:tie-a",
        "local:page:tie-b",
        "local:page:oldest",
      ]);

      // A pin sorts first, so the cursor must cross the pin boundary.
      await getDb()
        .update(juniorConversationParticipants)
        .set({ pinnedAt: new Date(4_000) })
        .where(
          and(
            eq(
              juniorConversationParticipants.rootConversationId,
              "local:page:tie-b",
            ),
            eq(juniorConversationParticipants.userId, viewer.id),
          ),
        );
      await expect(readEveryPage(viewer)).resolves.toEqual([
        "local:page:tie-b",
        "local:page:newest",
        "local:page:tie-a",
        "local:page:oldest",
      ]);

      const app = new Hono<JuniorApiEnv>();
      app.use("*", async (context, next) => {
        context.set("viewer", viewer);
        await next();
      });
      app.route("/", createJuniorApi());
      const invalid = await app.request(
        "http://localhost/api/conversations?cursor=not-a-cursor",
      );
      expect(invalid.status).toBe(400);
      expect(apiErrorSchema.parse(await invalid.json())).toEqual({
        error: "Invalid conversation cursor.",
      });
    } finally {
      setDashboardConversationLinkOptions(previousLinkOptions);
    }
  });
});
