import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { contextDistillationPreferenceSchema } from "@/api/schema";
import { closeDb, getConversationStore } from "@/chat/db";
import { mayDistillConversation } from "@/chat/distillation/eligibility";
import { resolveViewerUser } from "@/chat/plugins/viewer";

function authenticatedApi(email: string) {
  const app = new Hono<{ Variables: JuniorApiVariables }>();
  app.use("*", async (c, next) => {
    const viewer = await resolveViewerUser(email);
    if (!viewer) throw new Error("No authenticated User");
    c.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  return app;
}

const path = "http://localhost/api/me/distillation";

function update(enabled: boolean, otherFields: Record<string, unknown> = {}) {
  return {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled, ...otherFields }),
  };
}

describe("Conversation distillation preference", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("saves only the authenticated User's opt-in and lets them turn it off", async () => {
    const owner = authenticatedApi("owner@example.com");
    const other = authenticatedApi("other@example.com");
    const initial = await owner.request(path);
    expect(initial.status).toBe(200);
    expect(
      contextDistillationPreferenceSchema.parse(await initial.json()),
    ).toEqual({
      available: false,
      enabled: false,
    });

    const untrusted = await owner.request(
      path,
      update(true, { userId: "other" }),
    );
    expect(untrusted.status).toBe(400);

    const saved = await owner.request(path, update(true));
    expect(saved.status).toBe(200);
    expect(
      contextDistillationPreferenceSchema.parse(await saved.json()),
    ).toEqual({
      available: false,
      enabled: true,
    });
    expect(
      contextDistillationPreferenceSchema.parse(
        await (await other.request(path)).json(),
      ).enabled,
    ).toBe(false);
    expect(
      contextDistillationPreferenceSchema.parse(
        await (await owner.request(path)).json(),
      ).enabled,
    ).toBe(true);

    const conversationId = "slack:T1:private-opt-in";
    const actor = {
      platform: "slack" as const,
      email: "owner@example.com",
      teamId: "T1",
      userId: "U-owner",
    };
    const store = getConversationStore();
    await store.recordActivity({
      conversationId,
      actor: {
        email: actor.email,
        teamId: actor.teamId,
        slackUserId: actor.userId,
      },
      destination: { platform: "slack", teamId: "T1", channelId: "DPRIVATE" },
      visibility: "private",
    });
    const provenance = [{ authority: "instruction" as const, actor }];
    expect(
      await mayDistillConversation(conversationId, actor, provenance),
    ).toBe(true);

    await store.recordActivity({ conversationId, visibility: "public" });
    expect(
      await mayDistillConversation(conversationId, actor, provenance),
    ).toBe(false);
    await store.recordActivity({ conversationId, visibility: "private" });

    const disabled = await owner.request(path, update(false));
    expect(
      contextDistillationPreferenceSchema.parse(await disabled.json()).enabled,
    ).toBe(false);
    expect(
      await mayDistillConversation(conversationId, actor, provenance),
    ).toBe(false);
    expect((await createJuniorApi().request(path)).status).toBe(401);
    expect((await createJuniorApi().request(path, update(true))).status).toBe(
      401,
    );
  });
});
