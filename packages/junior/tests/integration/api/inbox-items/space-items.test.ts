import type { User } from "@sentry/junior-plugin-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setConversationSpace } from "@/chat/spaces/conversations";
import { createSpace } from "@/chat/spaces/store";
import { spawnChildAgent } from "../../../fixtures/agent-invocations";
import {
  closeConversationFixture,
  createConversationFixture,
  type ConversationFixture,
} from "../../../fixtures/conversation";
import {
  addEveryoneItem,
  addItem,
  addNotice,
  api,
  conversation,
  ROOT,
  user,
} from "../../../fixtures/snoozes";

// A root outside the Space.
const OTHER_ROOT = "slack:CSNOOZE:3.000001";
const HOUR_MS = 60 * 60 * 1000;

/** The titles that a Space's "Needs you" list shows to the viewer. */
async function needsYou(
  fixture: ConversationFixture,
  viewer: User,
  spaceId: string,
): Promise<string[]> {
  const list = (await api(fixture, viewer).json(
    `/inbox-items?spaceId=${spaceId}&needs=viewer`,
  )) as { items: { title: string }[] };
  return list.items.map((item) => item.title);
}

// The open Inbox items of a Space that need the viewer, as its page lists them.
describe("inbox items of a Space", () => {
  let fixture: ConversationFixture;

  beforeEach(async () => {
    fixture = await createConversationFixture();
  });

  afterEach(async () => {
    await closeConversationFixture();
  });

  it("lists the items that a Space's Conversations own and that need the viewer now", async () => {
    const ana = await user("ana@example.com");
    const bob = await user("bob@example.com");
    const space = await createSpace({
      creatorUserId: ana.id,
      description: null,
      name: "Billing migration",
      visibility: "public",
    });
    await conversation(ROOT, "public");
    await conversation(OTHER_ROOT, "public");
    expect(await setConversationSpace(ROOT, space.id, null)).toBeUndefined();
    const child = await spawnChildAgent({
      conversationStore: fixture.conversationStore,
      idempotencyKey: "space-items-child",
      parentConversationId: ROOT,
      queue: fixture.queue,
      state: fixture.state,
    });
    fixture.queue.takeMessageFor(child.childConversationId);

    await addItem(ROOT, [ana], "Pick the migration window");
    // A child's item is in the Space of its root.
    await addItem(child.childConversationId, [ana], "Approve the first batch");
    // Only Bob sees his private question.
    await addItem(ROOT, [bob], "Name the rollback owner", "private");
    // An item for Everyone and a notice need no one.
    await addEveryoneItem(ROOT, "Anyone: confirm the freeze");
    await addNotice(ROOT, [ana], "Migration started");
    // Another Conversation owns this item, so a link to the root does not
    // put it in the Space.
    await addItem(
      OTHER_ROOT,
      [ana],
      "Rotate the API key",
      "public",
      OTHER_ROOT,
      [ROOT],
    );
    const snoozed = await addItem(ROOT, [ana], "Pick the invoice format");
    const snooze = await api(fixture, ana).snooze(
      { conversationId: ROOT, inboxItemId: snoozed },
      Date.now() + HOUR_MS,
    );
    expect(snooze.status).toBe(201);

    expect(await needsYou(fixture, ana, space.id)).toEqual([
      "Pick the migration window",
      "Approve the first batch",
    ]);
    expect(await needsYou(fixture, bob, space.id)).toEqual([
      "Name the rollback owner",
    ]);
  });

  it("does not show a private Space to a person who is not a member", async () => {
    const ana = await user("ana@example.com");
    const bob = await user("bob@example.com");
    const space = await createSpace({
      creatorUserId: ana.id,
      description: null,
      name: "Pricing launch",
      visibility: "private",
    });

    expect(await needsYou(fixture, ana, space.id)).toEqual([]);
    const hidden = await api(fixture, bob).request(
      `/inbox-items?spaceId=${space.id}&needs=viewer`,
    );
    expect(hidden.status).toBe(404);
  });
});
