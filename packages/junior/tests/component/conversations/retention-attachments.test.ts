import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectAttachmentGarbage,
  storeAttachment,
} from "@/chat/attachments/store";
import {
  createMemoryAttachmentStorage,
  type MemoryAttachmentStorage,
} from "@/chat/attachments/memory";
import type { AttachmentWrite } from "@/chat/attachments/storage";
import { runRetentionPurge } from "@/chat/conversations/retention";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { juniorAttachments, juniorConversations } from "@/db/schema";
import {
  BASE_MS,
  DAY_MS,
  seedConversation,
  seedDestination,
} from "../../fixtures/conversation-retention";
import {
  createJuniorSqlFixture,
  type LocalJuniorSqlFixture,
} from "../../fixtures/sql";

/** Write one placeholder object so tests can check that cleanup removed it. */
async function putObject(
  storage: MemoryAttachmentStorage,
  key: string,
): Promise<void> {
  await storage.put({
    body: Buffer.from(key),
    contentType: "text/plain",
    key,
  });
}

describe("retention purge job: attachments", () => {
  let fixture: LocalJuniorSqlFixture;

  beforeEach(async () => {
    fixture = await createJuniorSqlFixture();
    await migrateSchema(fixture.sql);
  });

  afterEach(async () => {
    await fixture.close();
  });

  it("deletes attachment blobs after conversation content expires", async () => {
    const destinationId = await seedDestination(fixture.sql, "private");
    await seedConversation(fixture.sql, {
      conversationId: "with-attachment",
      destinationId,
      lastActivityAtMs: BASE_MS,
    });
    await fixture.sql
      .db()
      .insert(juniorAttachments)
      .values({
        id: "attachment-1",
        conversationId: "with-attachment",
        storageProvider: "memory",
        storageKey: "key-1",
        filename: "report.txt",
        contentType: "text/plain",
        bytes: 6,
        sha256: "digest",
        createdAt: new Date(BASE_MS),
      });
    const storage = createMemoryAttachmentStorage();
    await putObject(storage, "key-1");

    const result = await runRetentionPurge(fixture.sql, {
      attachmentStorage: storage,
      nowMs: BASE_MS + 15 * DAY_MS,
    });

    expect(result.attachments).toBe(1);
    expect([...storage.objects.keys()]).toEqual([]);
    expect(await fixture.sql.db().select().from(juniorAttachments)).toEqual([]);
  });

  it("deletes attachments 30 days after they are stored", async () => {
    const destinationId = await seedDestination(fixture.sql, "public");
    await seedConversation(fixture.sql, {
      conversationId: "active-with-attachments",
      destinationId,
      lastActivityAtMs: BASE_MS + 31 * DAY_MS,
    });
    await fixture.sql
      .db()
      .insert(juniorAttachments)
      .values([
        {
          id: "expired-attachment",
          conversationId: "active-with-attachments",
          storageProvider: "memory",
          storageKey: "expired-key",
          filename: "old.txt",
          contentType: "text/plain",
          bytes: 3,
          sha256: "old",
          createdAt: new Date(BASE_MS),
        },
        {
          id: "current-attachment",
          conversationId: "active-with-attachments",
          storageProvider: "memory",
          storageKey: "current-key",
          filename: "new.txt",
          contentType: "text/plain",
          bytes: 3,
          sha256: "new",
          createdAt: new Date(BASE_MS + 2 * DAY_MS),
        },
      ]);
    const storage = createMemoryAttachmentStorage();
    await putObject(storage, "expired-key");
    await putObject(storage, "current-key");

    const result = await runRetentionPurge(fixture.sql, {
      attachmentStorage: storage,
      nowMs: BASE_MS + 30 * DAY_MS,
    });

    expect(result.purged).toBe(0);
    expect(result.attachments).toBe(1);
    expect([...storage.objects.keys()]).toEqual(["current-key"]);
    expect(
      await fixture.sql.db().select().from(juniorAttachments),
    ).toMatchObject([{ id: "current-attachment" }]);
  });

  it("keeps marked attachment rows when blob delete fails", async () => {
    const destinationId = await seedDestination(fixture.sql, "private");
    await seedConversation(fixture.sql, {
      conversationId: "with-attachment",
      destinationId,
      lastActivityAtMs: BASE_MS,
    });
    await fixture.sql
      .db()
      .insert(juniorAttachments)
      .values({
        id: "attachment-1",
        conversationId: "with-attachment",
        storageProvider: "memory",
        storageKey: "key-1",
        filename: "report.txt",
        contentType: "text/plain",
        bytes: 6,
        sha256: "digest",
        createdAt: new Date(BASE_MS),
        deleteRequestedAt: new Date(BASE_MS + DAY_MS),
      });
    const storage = {
      ...createMemoryAttachmentStorage(),
      delete: async () => {
        throw new Error("blob delete failed");
      },
    };

    await expect(
      collectAttachmentGarbage({
        db: fixture.sql,
        nowMs: BASE_MS + 15 * DAY_MS,
        storage,
      }),
    ).rejects.toThrow("blob delete failed");

    const rows = await fixture.sql.db().select().from(juniorAttachments);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "attachment-1",
      storageKey: "key-1",
      deleteRequestedAt: expect.any(Date),
    });
  });

  it("collects unmarked attachments owned by purged conversations", async () => {
    const destinationId = await seedDestination(fixture.sql, "private");
    await seedConversation(fixture.sql, {
      conversationId: "purged-owner",
      destinationId,
      lastActivityAtMs: BASE_MS,
    });
    await fixture.sql
      .db()
      .update(juniorConversations)
      .set({ transcriptPurgedAt: new Date(BASE_MS + DAY_MS) })
      .where(eq(juniorConversations.conversationId, "purged-owner"));
    await fixture.sql
      .db()
      .insert(juniorAttachments)
      .values({
        id: "orphan-attachment",
        conversationId: "purged-owner",
        storageProvider: "memory",
        storageKey: "orphan-key",
        filename: "late.txt",
        contentType: "text/plain",
        bytes: 4,
        sha256: "orphan",
        createdAt: new Date(BASE_MS + DAY_MS),
      });
    const storage = createMemoryAttachmentStorage();
    await putObject(storage, "orphan-key");

    const result = await collectAttachmentGarbage({
      db: fixture.sql,
      nowMs: BASE_MS + 15 * DAY_MS,
      storage,
    });

    expect(result.deleted).toBe(1);
    expect([...storage.objects.keys()]).toEqual([]);
    expect(await fixture.sql.db().select().from(juniorAttachments)).toEqual([]);
  });

  it("rejects attachment stores into purged conversations", async () => {
    const destinationId = await seedDestination(fixture.sql, "private");
    await seedConversation(fixture.sql, {
      conversationId: "purged-owner",
      destinationId,
      lastActivityAtMs: BASE_MS,
    });
    await fixture.sql
      .db()
      .update(juniorConversations)
      .set({ transcriptPurgedAt: new Date(BASE_MS + DAY_MS) })
      .where(eq(juniorConversations.conversationId, "purged-owner"));
    const storage = createMemoryAttachmentStorage();

    await expect(
      storeAttachment({
        conversationId: "purged-owner",
        db: fixture.sql,
        file: {
          bytes: 4,
          data: Buffer.from("late"),
          filename: "late.txt",
          mimeType: "text/plain",
          path: "/tmp/late.txt",
        },
        storage,
      }),
    ).rejects.toThrow(/purged conversation/);

    expect([...storage.objects.keys()]).toEqual([]);
    expect(await fixture.sql.db().select().from(juniorAttachments)).toEqual([]);
  });

  it("marks and cleans a raced insert when purge wins after put", async () => {
    const destinationId = await seedDestination(fixture.sql, "private");
    await seedConversation(fixture.sql, {
      conversationId: "race-owner",
      destinationId,
      lastActivityAtMs: BASE_MS,
    });
    const memoryStorage = createMemoryAttachmentStorage();
    const puts: string[] = [];
    // Purge the conversation after the object is written, before the SQL row.
    const storage = {
      ...memoryStorage,
      put: async (input: AttachmentWrite) => {
        await memoryStorage.put(input);
        puts.push(input.key);
        await fixture.sql
          .db()
          .update(juniorConversations)
          .set({ transcriptPurgedAt: new Date(BASE_MS + DAY_MS) })
          .where(eq(juniorConversations.conversationId, "race-owner"));
      },
    };

    await expect(
      storeAttachment({
        conversationId: "race-owner",
        db: fixture.sql,
        file: {
          bytes: 4,
          data: Buffer.from("late"),
          filename: "late.txt",
          mimeType: "text/plain",
          path: "/tmp/late.txt",
        },
        storage,
      }),
    ).rejects.toThrow(/purged conversation/);

    const rows = await fixture.sql.db().select().from(juniorAttachments);
    expect(rows).toHaveLength(1);
    expect(puts).toEqual([rows[0]?.storageKey]);
    expect([...memoryStorage.objects.keys()]).toEqual([]);
    expect(rows[0]?.deleteRequestedAt).toEqual(expect.any(Date));
  });

  it("rejects live-row reuse when the conversation is already purged", async () => {
    const destinationId = await seedDestination(fixture.sql, "private");
    await seedConversation(fixture.sql, {
      conversationId: "purged-owner",
      destinationId,
      lastActivityAtMs: BASE_MS,
    });
    const liveKey = "live-key";
    const file = {
      bytes: 4,
      data: Buffer.from("late"),
      filename: "late.txt",
      mimeType: "text/plain",
      path: "/tmp/late.txt",
    };
    const storage = createMemoryAttachmentStorage();
    const stored = await storeAttachment({
      conversationId: "purged-owner",
      db: fixture.sql,
      file,
      storage,
    });
    const storedKeys = [...storage.objects.keys()];
    await fixture.sql
      .db()
      .update(juniorConversations)
      .set({ transcriptPurgedAt: new Date(BASE_MS + DAY_MS) })
      .where(eq(juniorConversations.conversationId, "purged-owner"));
    // Leave the row unmarked so reuse hits the live-row path, not revive.
    await fixture.sql
      .db()
      .update(juniorAttachments)
      .set({ deleteRequestedAt: null, storageKey: liveKey })
      .where(eq(juniorAttachments.id, stored.id));

    await expect(
      storeAttachment({
        conversationId: "purged-owner",
        db: fixture.sql,
        file,
        storage,
      }),
    ).rejects.toThrow(/purged conversation/);

    // Early live-row reuse rejects before writing or deleting an object.
    expect([...storage.objects.keys()]).toEqual(storedKeys);
    const rows = await fixture.sql.db().select().from(juniorAttachments);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: stored.id,
      storageKey: liveKey,
      deleteRequestedAt: null,
    });
  });
});
