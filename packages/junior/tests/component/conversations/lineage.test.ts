import { createSlackSource } from "@sentry/junior-plugin-api";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readConversationLineage } from "@/chat/conversations/lineage";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore, type SqlStore } from "@/chat/conversations/sql/store";
import { juniorConversations } from "@/db/schema";
import {
  createConfiguredJuniorSqlFixture,
  type LocalJuniorSqlFixture,
} from "../../fixtures/sql";

const ROOT_ID = "slack:C123:1700000000.000100";
const CHILD_ID = "agent:child";
const GRANDCHILD_ID = "agent:grandchild";

describe("Conversation lineage", () => {
  let fixture: LocalJuniorSqlFixture;
  let store: SqlStore;

  beforeEach(async () => {
    fixture = createConfiguredJuniorSqlFixture();
    await migrateSchema(fixture.sql);
    store = createSqlStore(fixture.sql);
    await store.recordActivity({
      conversationId: ROOT_ID,
      destination: { platform: "slack", teamId: "T123", channelId: "C123" },
      nowMs: 1_000,
      sessionSource: createSlackSource({
        channelId: "C123",
        teamId: "T123",
        threadTs: "1700000000.000100",
        visibility: "public",
      }),
      visibility: "public",
    });
    await store.createChild({
      childConversationId: CHILD_ID,
      kind: "task",
      parentConversationId: ROOT_ID,
      nowMs: 2_000,
    });
    await store.createChild({
      childConversationId: GRANDCHILD_ID,
      kind: "thread",
      parentConversationId: CHILD_ID,
      nowMs: 3_000,
    });
  });

  afterEach(async () => {
    await fixture.close();
  });

  it("reads the parent chain root first", async () => {
    await expect(readConversationLineage(GRANDCHILD_ID)).resolves.toEqual([
      { conversationId: ROOT_ID, kind: "root" },
      { conversationId: CHILD_ID, kind: "task", parentConversationId: ROOT_ID },
      {
        conversationId: GRANDCHILD_ID,
        kind: "thread",
        parentConversationId: CHILD_ID,
      },
    ]);
  });

  it("reads a root as a chain of one and a missing Conversation as no chain", async () => {
    await expect(readConversationLineage(ROOT_ID)).resolves.toEqual([
      { conversationId: ROOT_ID, kind: "root" },
    ]);
    await expect(readConversationLineage("agent:missing")).resolves.toEqual([]);
  });

  it("stops a parent cycle at the first repeated Conversation", async () => {
    // Bad data: no writer can link a root to its own descendant.
    await fixture.sql
      .db()
      .update(juniorConversations)
      .set({ kind: "task", parentConversationId: GRANDCHILD_ID })
      .where(eq(juniorConversations.conversationId, ROOT_ID));

    const lineage = await readConversationLineage(GRANDCHILD_ID);

    expect(lineage.map((entry) => entry.conversationId)).toEqual([
      ROOT_ID,
      CHILD_ID,
      GRANDCHILD_ID,
    ]);
    // The first entry still has a parent, so callers read a broken chain.
    expect(lineage[0]).toMatchObject({ parentConversationId: GRANDCHILD_ID });
  });
});
