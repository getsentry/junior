import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { conversationOutlineSchema } from "@/api/schema";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import {
  closeDb,
  getConversationEventStore,
  getConversationStore,
} from "@/chat/db";

function message(
  messageId: string,
  role: "assistant" | "user",
  text: string,
  meta?: Record<string, unknown>,
) {
  return {
    data: {
      type: "message" as const,
      messageId,
      role,
      text,
      ...(meta ? { meta } : undefined),
    },
    createdAtMs: 1,
  };
}

async function readOutline(
  conversationId: string,
  app: {
    request(url: string): Response | Promise<Response>;
  } = createJuniorApi(),
) {
  const response = await app.request(
    `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/outline`,
  );
  expect(response.status).toBe(200);
  return conversationOutlineSchema.parse(await response.json());
}

describe("conversation outline API", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("lists the person messages of the whole Conversation", async () => {
    const conversationId = "local:test:outline";
    await getConversationStore().recordActivity({
      destination: { platform: "local" as const, conversationId },
      conversationId,
      nowMs: 1,
      source: "internal",
      title: "Outline",
      visibility: "public",
    });
    // The mention starts before the cut and ends after it.
    const long = `${"a".repeat(195)} <@U123456789> rest`;
    const link = `https://example.com/${"b".repeat(300)}`;
    await getConversationEventStore().append(conversationId, [
      message("first", "user", "  first question  "),
      // More events than one default detail page.
      ...Array.from({ length: 200 }, (_, index) =>
        message(`reply-${index}`, "assistant", `reply ${index}`),
      ),
      message("event", "user", "issue created", { eventType: "issue.created" }),
      message("context", "user", "thread chatter", { explicitMention: false }),
      message("empty", "user", "   "),
      message("mention", "user", "hi <@U1>", { explicitMention: true }),
      message("long", "user", long),
      message("link", "user", `<${link}>`),
    ]);

    const outline = await readOutline(conversationId);

    expect(outline.items.map((item) => item.text)).toEqual([
      "first question",
      "hi <@U1>",
      "a".repeat(195),
      link.slice(0, 199),
    ]);
    expect(outline.items[0]?.seq).toBeLessThan(outline.items[1]!.seq);
  });

  it("lists no items for a viewer who cannot see the transcript", async () => {
    const conversationId = "slack:C-private:outline";
    await getConversationStore().recordActivity({
      actor: {
        email: "Participant@Example.com",
        platform: "slack",
        slackUserId: "U-participant",
        teamId: "TPRIVATE",
      },
      conversationId,
      destination: {
        channelId: "CPRIVATE",
        platform: "slack",
        teamId: "TPRIVATE",
      },
      nowMs: 1,
      source: "slack",
      title: "Private outline",
      visibility: "private",
    });
    await getConversationEventStore().append(conversationId, [
      message("private", "user", "private question"),
    ]);

    expect(await readOutline(conversationId)).toEqual({ items: [] });

    const participantApi = new Hono<{ Variables: JuniorApiVariables }>();
    participantApi.use("*", async (context, next) => {
      const viewer = await resolveViewerUser("participant@example.COM");
      if (!viewer) throw new Error("missing viewer for participant");
      context.set("viewer", viewer);
      await next();
    });
    participantApi.route("/", createJuniorApi());
    const outline = await readOutline(conversationId, participantApi);
    expect(outline.items.map((item) => item.text)).toEqual([
      "private question",
    ]);
  });

  it("answers 404 for a missing Conversation", async () => {
    const response = await createJuniorApi().request(
      "http://localhost/api/conversations/local%3Atest%3Amissing/outline",
    );
    expect(response.status).toBe(404);
  });
});
