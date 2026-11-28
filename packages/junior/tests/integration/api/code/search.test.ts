import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { githubPlugin } from "@sentry/junior-github";
import { createApp, defineJuniorPlugins } from "@/app";
import type { CodeChangeInput } from "@sentry/junior-plugin-api";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import { apiErrorSchema, codeChangeSearchReportSchema } from "@/api/schema";
import { recordCodeChange } from "@/chat/code/store";
import {
  closeDb,
  getConversationStore,
  getDb,
  getSqlExecutor,
} from "@/chat/db";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import {
  juniorConversationParticipants,
  juniorConversations,
} from "@/db/schema";
import { expectSqlBudget } from "../../../fixtures/sql-budget";

/** A dashboard API signed in as one person. */
async function signedIn(email: string) {
  const viewer = await resolveViewerUser(email);
  if (!viewer) throw new Error(`missing viewer for ${email}`);
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  const request = (query: string) =>
    app.request(
      `http://localhost/api/code/changes/search?${new URLSearchParams({ q: query })}`,
    );
  const search = async (query: string) => {
    const response = await request(query);
    expect(response.status).toBe(200);
    return codeChangeSearchReportSchema.parse(await response.json()).changes;
  };
  return { request, search, viewer };
}

async function conversation(
  conversationId: string,
  visibility: "public" | "private",
) {
  await getConversationStore().recordActivity({
    conversationId,
    destination: {
      channelId: conversationId.split(":")[1]!,
      platform: "slack",
      teamId: "T1",
    },
    nowMs: Date.parse("2026-08-20T12:00:00.000Z"),
    source: "internal",
    title: conversationId,
    visibility,
  });
}

async function codeChange(args: {
  conversationIds: string[];
  day: number;
  number: number;
  repository?: string;
  title: string;
}) {
  const repository = args.repository ?? "getsentry/junior";
  const at = new Date(Date.UTC(2026, 7, args.day, 12));
  await recordCodeChange(getDb(), "github", {
    conversationIds: args.conversationIds,
    number: args.number,
    openedAt: at,
    providerId: `${repository}#${args.number}`,
    repository: { name: repository, providerId: repository },
    state: "open",
    title: args.title,
    updatedAt: at,
  } satisfies CodeChangeInput);
}

describe("code change search API", () => {
  // The GitHub plugin builds the code links.
  beforeEach(async () => {
    await createApp({ plugins: defineJuniorPlugins([githubPlugin()]) });
  });

  afterEach(async () => {
    await closeDb();
  });

  it("finds changes the viewer can see by number, title, or repository", async () => {
    await conversation("slack:C1:public", "public");
    await conversation("slack:D1:mine", "private");
    await conversation("slack:D2:theirs", "private");
    await codeChange({
      conversationIds: ["slack:C1:public"],
      day: 10,
      number: 1234,
      title: "Add the composer menu",
    });
    await codeChange({
      conversationIds: ["slack:D1:mine"],
      day: 11,
      number: 1250,
      title: "Fix the composer focus",
    });
    await codeChange({
      conversationIds: ["slack:D2:theirs"],
      day: 12,
      number: 1260,
      title: "Secret composer work",
    });
    await codeChange({
      conversationIds: ["slack:C1:public"],
      day: 13,
      number: 12,
      repository: "getsentry/sentry-docs",
      title: "Document the menu",
    });
    const { search, viewer } = await signedIn("ana@example.com");
    await getDb()
      .insert(juniorConversationParticipants)
      .values({
        lastMessageAt: new Date("2026-08-20T12:00:00.000Z"),
        rootConversationId: "slack:D1:mine",
        userId: viewer.id,
      });

    const byNumber = await expectSqlBudget(() => search("#12"), {
      statements: 4,
      serialRounds: 4,
    });
    // An exact number comes first, then newest activity. A change linked
    // only to another person's private Conversation never shows.
    expect(byNumber.map((change) => change.number)).toEqual([12, 1250, 1234]);
    expect(byNumber[0]).toEqual({
      number: 12,
      repository: "getsentry/sentry-docs",
      state: "open",
      title: "Document the menu",
      url: "https://github.com/getsentry/sentry-docs/pull/12",
    });
    expect((await search("123")).map((change) => change.number)).toEqual([
      1234,
    ]);
    expect((await search("compo")).map((change) => change.number)).toEqual([
      1250, 1234,
    ]);
    expect((await search("docs men")).map((change) => change.number)).toEqual([
      12,
    ]);
    expect(await search("secret")).toEqual([]);
    // Punctuation is not tsquery syntax.
    expect(await search("&|!")).toEqual([]);
  });

  it("returns at most 8 changes and rejects an empty query", async () => {
    await conversation("slack:C1:public", "public");
    for (let number = 1; number <= 10; number += 1) {
      await codeChange({
        conversationIds: ["slack:C1:public"],
        day: number,
        number,
        title: `Ship step ${number}`,
      });
    }
    // Other Conversations, so a visibility check that reads every root for
    // each matching change costs that read once per change.
    const [root] = await getDb()
      .select()
      .from(juniorConversations)
      .where(eq(juniorConversations.conversationId, "slack:C1:public"));
    await getDb()
      .insert(juniorConversations)
      .values(
        Array.from({ length: 1_000 }, (_, index) => ({
          ...root!,
          conversationId: `slack:C1:other-${index}`,
          rootConversationId: `slack:C1:other-${index}`,
        })),
      );
    await getSqlExecutor().query("analyze");
    const { request, search } = await signedIn("ana@example.com");

    const shipped = await search("ship");
    expect(shipped.map((change) => change.number)).toEqual([
      10, 9, 8, 7, 6, 5, 4, 3,
    ]);
    const bad = await request(" ");
    expect(bad.status).toBe(400);
    expect(apiErrorSchema.parse(await bad.json()).error).toBe(
      "Invalid search query.",
    );
  });
});
