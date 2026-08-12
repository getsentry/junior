import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  purgeConversation,
  runRetentionPurge,
} from "@/chat/conversations/retention";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import {
  purgeConversationTree,
  selectExpiredRoots,
} from "@/chat/conversations/sql/purge";
import {
  juniorAttachments,
  juniorConversationEvents,
  juniorConversations,
  juniorDestinations,
  juniorAgentBindings,
  juniorAgentInvocations,
} from "@/db/schema";
import type { JuniorDestinationVisibility } from "@/db/schema/destinations";
import type { JuniorSqlDatabase } from "@/db/db";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import {
  createLocalJuniorSqlFixture,
  type LocalJuniorSqlFixture,
} from "../../fixtures/sql";

const DAY_MS = 24 * 60 * 60 * 1000;
const BASE_MS = Date.UTC(2026, 0, 1);

async function seedDestination(
  executor: JuniorSqlDatabase,
  visibility: JuniorDestinationVisibility,
): Promise<string> {
  const id = randomUUID();
  await executor
    .db()
    .insert(juniorDestinations)
    .values({
      id,
      provider: "slack",
      providerTenantId: "T1",
      providerDestinationId: `C-${id.slice(0, 8)}`,
      kind: "channel",
      visibility,
      createdAt: new Date(BASE_MS),
      updatedAt: new Date(BASE_MS),
    });
  return id;
}

async function seedConversation(
  executor: JuniorSqlDatabase,
  args: {
    conversationId: string;
    destinationId?: string;
    lastActivityAtMs: number;
    parentConversationId?: string;
    title?: string | null;
    channelName?: string | null;
    withContent?: boolean;
  },
): Promise<void> {
  const at = new Date(args.lastActivityAtMs);
  await executor
    .db()
    .insert(juniorConversations)
    .values({
      conversationId: args.conversationId,
      schemaVersion: 1,
      destinationId: args.destinationId ?? null,
      parentConversationId: args.parentConversationId ?? null,
      title: args.title === undefined ? "A title" : args.title,
      channelName: args.channelName === undefined ? "eng" : args.channelName,
      actor: { platform: "slack", slackUserId: "U1", teamId: "T1" },
      createdAt: new Date(BASE_MS),
      lastActivityAt: at,
      updatedAt: at,
      executionStatus: "idle",
    });
  if (args.withContent !== false) {
    await executor
      .db()
      .insert(juniorConversationEvents)
      .values({
        conversationId: args.conversationId,
        seq: 0,
        historyVersion: 0,
        schemaVersion: 1,
        type: "message",
        payload: { messageId: "m1", role: "user", text: "hi" },
        createdAt: at,
      });
  }
}

async function eventCount(
  executor: JuniorSqlDatabase,
  conversationId: string,
): Promise<number> {
  const rows = await executor
    .db()
    .select()
    .from(juniorConversationEvents)
    .where(eq(juniorConversationEvents.conversationId, conversationId));
  return rows.length;
}

async function readConversation(
  executor: JuniorSqlDatabase,
  conversationId: string,
): Promise<typeof juniorConversations.$inferSelect> {
  const rows = await executor
    .db()
    .select()
    .from(juniorConversations)
    .where(eq(juniorConversations.conversationId, conversationId));
  return rows[0]!;
}

async function setVisibility(
  executor: JuniorSqlDatabase,
  destinationId: string,
  visibility: JuniorDestinationVisibility,
): Promise<void> {
  await executor
    .db()
    .update(juniorDestinations)
    .set({ visibility })
    .where(eq(juniorDestinations.id, destinationId));
}

describe("retention purge job", () => {
  let fixture: LocalJuniorSqlFixture;

  beforeEach(async () => {
    fixture = await createLocalJuniorSqlFixture();
    await migrateSchema(fixture.sql);
  });

  afterEach(async () => {
    await fixture.close();
  });

  it("keeps public at 15 days, purges public at 91 days, and private at 15 days", async () => {
    const publicDest = await seedDestination(fixture.sql, "public");
    const privateDest = await seedDestination(fixture.sql, "private");
    await seedConversation(fixture.sql, {
      conversationId: "pub",
      destinationId: publicDest,
      lastActivityAtMs: BASE_MS,
    });
    await seedConversation(fixture.sql, {
      conversationId: "priv",
      destinationId: privateDest,
      lastActivityAtMs: BASE_MS,
    });

    // At 15 days: private is expired (14d window), public is retained (90d).
    const first = await runRetentionPurge(fixture.sql, {
      nowMs: BASE_MS + 15 * DAY_MS,
    });
    expect(first.purged).toBe(1);
    expect(await eventCount(fixture.sql, "priv")).toBe(0);
    expect(await eventCount(fixture.sql, "pub")).toBe(1);
    expect(
      (await readConversation(fixture.sql, "pub")).transcriptPurgedAt,
    ).toBe(null);

    // At 91 days: the public conversation crosses its 90-day window.
    const second = await runRetentionPurge(fixture.sql, {
      nowMs: BASE_MS + 91 * DAY_MS,
    });
    expect(second.purged).toBe(1);
    expect(await eventCount(fixture.sql, "pub")).toBe(0);
  });

  it("deletes attachment blobs after conversation content expires", async () => {
    const destinationId = await seedDestination(fixture.sql, "private");
    await seedConversation(fixture.sql, {
      conversationId: "with-attachment",
      destinationId,
      lastActivityAtMs: BASE_MS,
    });
    await fixture.sql.db().insert(juniorAttachments).values({
      id: "attachment-1",
      conversationId: "with-attachment",
      provider: "test",
      storageKey: "key-1",
      filename: "report.txt",
      contentType: "text/plain",
      bytes: 6,
      sha256: "digest",
      createdAt: new Date(BASE_MS),
      readyAt: new Date(BASE_MS),
    });
    const deleted: string[][] = [];
    const storage: AttachmentStorage = {
      provider: "test",
      put: async () => undefined,
      delete: async (keys) => {
        deleted.push(keys);
      },
    };

    const result = await runRetentionPurge(fixture.sql, {
      attachmentStorage: storage,
      nowMs: BASE_MS + 15 * DAY_MS,
    });

    expect(result.attachments).toBe(1);
    expect(deleted).toEqual([["key-1"]]);
    expect(await fixture.sql.db().select().from(juniorAttachments)).toEqual([]);
  });

  it("shortens the window when visibility flips public to private", async () => {
    const dest = await seedDestination(fixture.sql, "public");
    await seedConversation(fixture.sql, {
      conversationId: "flip",
      destinationId: dest,
      lastActivityAtMs: BASE_MS,
    });

    // Still public at 15 days: retained.
    await runRetentionPurge(fixture.sql, { nowMs: BASE_MS + 15 * DAY_MS });
    expect(await eventCount(fixture.sql, "flip")).toBe(1);

    // Flip to private, then the next pass at 15 days applies the 14-day window.
    await setVisibility(fixture.sql, dest, "private");
    const result = await runRetentionPurge(fixture.sql, {
      nowMs: BASE_MS + 15 * DAY_MS,
    });
    expect(result.purged).toBe(1);
    expect(await eventCount(fixture.sql, "flip")).toBe(0);
  });

  it("rechecks activity and visibility inside the destructive transaction", async () => {
    const dest = await seedDestination(fixture.sql, "public");
    await seedConversation(fixture.sql, {
      conversationId: "raced",
      destinationId: dest,
      lastActivityAtMs: BASE_MS,
    });
    const nowMs = BASE_MS + 91 * DAY_MS;
    await expect(
      selectExpiredRoots(fixture.sql, {
        nowMs,
        publicWindowMs: 90 * DAY_MS,
        privateWindowMs: 14 * DAY_MS,
        limit: 10,
      }),
    ).resolves.toEqual([expect.objectContaining({ conversationId: "raced" })]);

    await fixture.sql
      .db()
      .update(juniorConversations)
      .set({ lastActivityAt: new Date(nowMs), updatedAt: new Date(nowMs) })
      .where(eq(juniorConversations.conversationId, "raced"));
    await setVisibility(fixture.sql, dest, "private");

    await expect(
      purgeConversationTree(fixture.sql, {
        rootConversationId: "raced",
        nowMs,
        retention: {
          publicWindowMs: 90 * DAY_MS,
          privateWindowMs: 14 * DAY_MS,
        },
      }),
    ).resolves.toEqual({ purged: false, conversations: 0 });
    expect(await eventCount(fixture.sql, "raced")).toBe(1);
  });

  it("rides descendants on the root window and purges the whole subtree", async () => {
    const dest = await seedDestination(fixture.sql, "public");
    // Fresh public root, but its advisor child has old activity and content.
    await seedConversation(fixture.sql, {
      conversationId: "root",
      destinationId: dest,
      lastActivityAtMs: BASE_MS + 100 * DAY_MS,
    });
    await seedConversation(fixture.sql, {
      conversationId: "child",
      parentConversationId: "root",
      lastActivityAtMs: BASE_MS,
    });
    await seedConversation(fixture.sql, {
      conversationId: "grandchild",
      parentConversationId: "child",
      lastActivityAtMs: BASE_MS,
    });
    await fixture.sql
      .db()
      .insert(juniorAgentInvocations)
      .values({
        actor: { name: "parent-agent", platform: "system" },
        childConversationId: "child",
        createdAt: new Date(BASE_MS),
        destination: { conversationId: "root", platform: "local" },
        destinationVisibility: "private",
        input: "private delegated input",
        invocationId: "agent-invocation:retained",
        mailboxStatus: "appended",
        parentConversationId: "root",
        result: "private delegated result",
        source: {
          conversationId: "root",
          platform: "local",
          visibility: "private",
        },
        status: "completed",
        terminalAt: new Date(BASE_MS),
        updatedAt: new Date(BASE_MS),
      });

    // The child is never a purge candidate on its own: it rides the root.
    const result = await runRetentionPurge(fixture.sql, {
      nowMs: BASE_MS + 30 * DAY_MS,
    });
    expect(result.purged).toBe(0);
    expect(await eventCount(fixture.sql, "child")).toBe(1);
    expect(await eventCount(fixture.sql, "grandchild")).toBe(1);

    // Erasing the root purges the child's content too.
    await purgeConversation(fixture.sql, "root", {
      nowMs: BASE_MS + 30 * DAY_MS,
    });
    expect(await eventCount(fixture.sql, "root")).toBe(0);
    expect(await eventCount(fixture.sql, "child")).toBe(0);
    expect(await eventCount(fixture.sql, "grandchild")).toBe(0);
    await expect(
      fixture.sql.db().select().from(juniorAgentInvocations),
    ).resolves.toEqual([]);
  });

  it("uses the freshest activity in the tree for selection and destructive recheck", async () => {
    const destinationId = await seedDestination(fixture.sql, "public");
    const nowMs = BASE_MS + 100 * DAY_MS;
    await seedConversation(fixture.sql, {
      conversationId: "old-root",
      destinationId,
      lastActivityAtMs: BASE_MS,
    });
    await seedConversation(fixture.sql, {
      conversationId: "fresh-child",
      parentConversationId: "old-root",
      lastActivityAtMs: nowMs - DAY_MS,
    });

    await expect(
      selectExpiredRoots(fixture.sql, {
        nowMs,
        publicWindowMs: 90 * DAY_MS,
        privateWindowMs: 14 * DAY_MS,
        limit: 10,
      }),
    ).resolves.toEqual([]);
    await expect(
      purgeConversationTree(fixture.sql, {
        rootConversationId: "old-root",
        nowMs,
        retention: {
          publicWindowMs: 90 * DAY_MS,
          privateWindowMs: 14 * DAY_MS,
        },
      }),
    ).resolves.toEqual({ purged: false, conversations: 0 });
    expect(await eventCount(fixture.sql, "old-root")).toBe(1);
    expect(await eventCount(fixture.sql, "fresh-child")).toBe(1);
  });

  it("keeps a tree when a child write finishes before purge locks the child", async () => {
    const destinationId = await seedDestination(fixture.sql, "public");
    const nowMs = BASE_MS + 100 * DAY_MS;
    await seedConversation(fixture.sql, {
      conversationId: "racing-root",
      destinationId,
      lastActivityAtMs: BASE_MS,
    });
    await seedConversation(fixture.sql, {
      conversationId: "racing-child",
      parentConversationId: "racing-root",
      lastActivityAtMs: BASE_MS,
    });

    let childWriteCompleted = false;
    const racingExecutor: JuniorSqlDatabase = {
      db: () => fixture.sql.db(),
      transaction: (callback) => fixture.sql.transaction(callback),
      withLock: async (name, callback) => {
        if (
          !childWriteCompleted &&
          name === "junior_conversation:event:racing-child"
        ) {
          await fixture.sql
            .db()
            .update(juniorConversations)
            .set({
              lastActivityAt: new Date(nowMs),
              updatedAt: new Date(nowMs),
            })
            .where(eq(juniorConversations.conversationId, "racing-child"));
          childWriteCompleted = true;
        }
        return await fixture.sql.withLock(name, callback);
      },
    };

    await expect(
      purgeConversationTree(racingExecutor, {
        rootConversationId: "racing-root",
        nowMs,
        retention: {
          publicWindowMs: 90 * DAY_MS,
          privateWindowMs: 14 * DAY_MS,
        },
      }),
    ).resolves.toEqual({ purged: false, conversations: 0 });
    expect(childWriteCompleted).toBe(true);
    expect(await eventCount(fixture.sql, "racing-root")).toBe(1);
    expect(await eventCount(fixture.sql, "racing-child")).toBe(1);
  });

  it("purges an expired root whose remaining content exists only on a child", async () => {
    const dest = await seedDestination(fixture.sql, "public");
    await seedConversation(fixture.sql, {
      conversationId: "empty-root",
      destinationId: dest,
      lastActivityAtMs: BASE_MS,
      title: null,
      channelName: null,
      withContent: false,
    });
    await fixture.sql
      .db()
      .update(juniorConversations)
      .set({ actor: null })
      .where(eq(juniorConversations.conversationId, "empty-root"));
    await seedConversation(fixture.sql, {
      conversationId: "remaining-child",
      parentConversationId: "empty-root",
      lastActivityAtMs: BASE_MS,
    });

    const result = await runRetentionPurge(fixture.sql, {
      nowMs: BASE_MS + 91 * DAY_MS,
    });

    expect(result.purged).toBe(1);
    expect(await eventCount(fixture.sql, "remaining-child")).toBe(0);
  });

  it("selects and purges a tree whose remaining content is only an agent binding", async () => {
    const dest = await seedDestination(fixture.sql, "private");
    await seedConversation(fixture.sql, {
      conversationId: "binding-root",
      destinationId: dest,
      lastActivityAtMs: BASE_MS,
      title: null,
      channelName: null,
      withContent: false,
    });
    await fixture.sql
      .db()
      .update(juniorConversations)
      .set({ actor: null })
      .where(eq(juniorConversations.conversationId, "binding-root"));
    await seedConversation(fixture.sql, {
      conversationId: "binding-child",
      parentConversationId: "binding-root",
      lastActivityAtMs: BASE_MS,
      title: null,
      channelName: null,
      withContent: false,
    });
    await fixture.sql
      .db()
      .update(juniorConversations)
      .set({ actor: null })
      .where(eq(juniorConversations.conversationId, "binding-child"));
    await fixture.sql.db().insert(juniorAgentBindings).values({
      childConversationId: "binding-child",
      name: "retained-name",
      parentConversationId: "binding-root",
    });

    const result = await runRetentionPurge(fixture.sql, {
      nowMs: BASE_MS + 30 * DAY_MS,
    });

    expect(result.purged).toBe(1);
    await expect(
      fixture.sql.db().select().from(juniorAgentBindings),
    ).resolves.toEqual([]);
  });

  it("purges up to the batch limit and leaves the remainder for the next run", async () => {
    const dest = await seedDestination(fixture.sql, "private");
    await seedConversation(fixture.sql, {
      conversationId: "a",
      destinationId: dest,
      lastActivityAtMs: BASE_MS,
    });
    await seedConversation(fixture.sql, {
      conversationId: "b",
      destinationId: dest,
      lastActivityAtMs: BASE_MS + DAY_MS,
    });
    await seedConversation(fixture.sql, {
      conversationId: "c",
      destinationId: dest,
      lastActivityAtMs: BASE_MS + 2 * DAY_MS,
    });

    const nowMs = BASE_MS + 30 * DAY_MS;
    const first = await runRetentionPurge(fixture.sql, { nowMs, limit: 2 });
    expect(first.scanned).toBe(2);
    expect(first.purged).toBe(2);
    // Oldest-activity-first: "a" and "b" go, "c" remains.
    expect(await eventCount(fixture.sql, "a")).toBe(0);
    expect(await eventCount(fixture.sql, "c")).toBe(1);

    const second = await runRetentionPurge(fixture.sql, { nowMs, limit: 2 });
    expect(second.purged).toBe(1);
    expect(await eventCount(fixture.sql, "c")).toBe(0);

    // Nothing left to do once everything is purged.
    const third = await runRetentionPurge(fixture.sql, { nowMs, limit: 2 });
    expect(third.purged).toBe(0);
  });

  it("scrubs private metadata but retains public title on purge", async () => {
    const publicDest = await seedDestination(fixture.sql, "public");
    const privateDest = await seedDestination(fixture.sql, "private");
    await seedConversation(fixture.sql, {
      conversationId: "pub",
      destinationId: publicDest,
      lastActivityAtMs: BASE_MS,
      title: "Public title",
    });
    await seedConversation(fixture.sql, {
      conversationId: "priv",
      destinationId: privateDest,
      lastActivityAtMs: BASE_MS,
      title: "Secret title",
    });

    await runRetentionPurge(fixture.sql, { nowMs: BASE_MS + 100 * DAY_MS });

    const pub = await readConversation(fixture.sql, "pub");
    expect(pub.transcriptPurgedAt).not.toBe(null);
    expect(pub.title).toBe("Public title");
    expect(pub.channelName).toBe("eng");
    expect(pub.actor).not.toBe(null);

    const priv = await readConversation(fixture.sql, "priv");
    expect(priv.transcriptPurgedAt).not.toBe(null);
    expect(priv.title).toBe(null);
    expect(priv.channelName).toBe(null);
    expect(priv.actor).toBe(null);
    // The metadata row itself survives the purge.
    expect(priv.conversationId).toBe("priv");
  });

  it("erases a fresh conversation immediately regardless of age", async () => {
    const dest = await seedDestination(fixture.sql, "private");
    await seedConversation(fixture.sql, {
      conversationId: "fresh",
      destinationId: dest,
      lastActivityAtMs: BASE_MS,
      title: "Fresh secret",
    });

    // A daily pass at the same instant would keep it (well inside 14 days).
    const pass = await runRetentionPurge(fixture.sql, { nowMs: BASE_MS });
    expect(pass.purged).toBe(0);
    expect(await eventCount(fixture.sql, "fresh")).toBe(1);

    await purgeConversation(fixture.sql, "fresh", { nowMs: BASE_MS });
    expect(await eventCount(fixture.sql, "fresh")).toBe(0);
    const row = await readConversation(fixture.sql, "fresh");
    expect(row.transcriptPurgedAt).not.toBe(null);
    expect(row.title).toBe(null);
  });
});
