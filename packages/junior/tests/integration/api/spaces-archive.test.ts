import { afterEach, describe, expect, it } from "vitest";
import { spaceSchema } from "@/api/schema";
import { setConversationArchive } from "@/api/conversations/archive";
import { getConversationStoppedAtMs } from "@/chat/conversations/session-stop";
import { getConversationStore } from "@/chat/db";
import { getSpaceLead } from "@/chat/lead/conversation";
import { closeConversationFixture } from "../../fixtures/conversation";
import {
  apiFor,
  createSpace,
  request,
  send,
  spaceFeed,
  startConversation,
  startThread,
} from "../../fixtures/spaces-api";

describe("Space archive API", () => {
  afterEach(async () => {
    await closeConversationFixture();
  });

  it("stops and archives the Lead's tree when a Space is archived", async () => {
    const ana = apiFor("spaces-archive-ana@example.com");
    const space = await createSpace(ana, "Short project");
    const first = await startConversation(ana, "short-first", {
      spaceId: space.id,
    });
    const second = await startConversation(ana, "short-second", {
      spaceId: space.id,
    });
    const done = await startConversation(ana, "short-done", {
      spaceId: space.id,
    });
    const outside = await startConversation(ana, "short-outside");
    const thread = await startThread(first, "local:spaces-archive-thread");
    const archiveConversation = async (conversationId: string) => {
      const conversation = await getConversationStore().get({
        conversationId,
      });
      return await request(
        ana,
        "PATCH",
        `/conversations/${encodeURIComponent(conversationId)}/archive`,
        {
          applyToChildren: true,
          lastSeenAt: new Date(
            conversation?.lastActivityAtMs ?? 0,
          ).toISOString(),
        },
      );
    };
    // A Conversation archived on its own stays archived after a restore.
    expect((await archiveConversation(done)).status).toBe(200);

    await send(ana, "PATCH", `/${space.id}/archive`, { archived: true });
    // A repeat or concurrent archive keeps the first archive's time.
    await send(ana, "PATCH", `/${space.id}/archive`, { archived: true });
    expect(await spaceFeed(ana, space.id)).toEqual([]);
    expect(
      (await spaceFeed(ana, space.id, "archived"))
        .map((row) => row.conversationId)
        .sort(),
    ).toEqual([first, second, done].sort());
    expect(await getConversationStoppedAtMs(first)).toBeDefined();
    expect(await getConversationStoppedAtMs(second)).toBeDefined();
    expect(await getConversationStoppedAtMs(outside)).toBeUndefined();
    expect(
      (await getConversationStore().get({ conversationId: outside }))
        ?.archivedAtMs,
    ).toBeUndefined();
    expect(
      (await getConversationStore().get({ conversationId: thread }))
        ?.archivedAtMs,
    ).toBeDefined();
    // An archived Space takes no new work.
    expect(
      (
        await request(ana, "POST", "/conversations", {
          idempotencyKey: "short-late",
          message: "One more",
          spaceId: space.id,
        })
      ).status,
    ).toBe(409);

    // A raced second archive keeps the first time, so restore still
    // brings back what the archive archived.
    const lead = await getSpaceLead(space.id);
    await setConversationArchive({
      applyToChildren: true,
      archived: true,
      conversationId: lead.conversationId,
    });
    await send(ana, "PATCH", `/${space.id}/archive`, { archived: false });
    expect(
      (await spaceFeed(ana, space.id)).map((row) => row.conversationId).sort(),
    ).toEqual([first, second].sort());

    // The Space's archive is its Lead's, so archiving the Lead as any root
    // archives the Space.
    expect((await archiveConversation(lead.conversationId)).status).toBe(200);
    expect(
      spaceSchema.parse(await (await send(ana, "GET", `/${space.id}`)).json())
        .archivedAt,
    ).not.toBeNull();

    // A second archive stops the Space again, though its Lead was stopped.
    const firstStopMs = await getConversationStoppedAtMs(first);
    await send(ana, "PATCH", `/${space.id}/archive`, { archived: true });
    expect(await getConversationStoppedAtMs(first)).toBeGreaterThan(
      firstStopMs ?? 0,
    );
  });
});
