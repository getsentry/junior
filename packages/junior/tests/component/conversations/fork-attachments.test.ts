import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { forkConversationForViewer } from "@/api/conversations/fork";
import { testViewer } from "../../fixtures/user";
import { createPostgresJuniorSqlExecutor } from "@/db/postgres";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { purgeConversationTree } from "@/chat/conversations/sql/purge";
import { juniorDestinations } from "@/db/schema";
import { webActorFromEmail } from "@/chat/conversations/web-input";
import { storeAttachment, readLiveAttachment } from "@/chat/attachments/store";
import {
  getConversationStore,
  getConversationEventStore,
  getSqlExecutor,
  getDb,
  closeDb,
} from "@/chat/db";
import { juniorAttachments } from "@/db/schema";
import { memoryAttachmentStorage } from "../../fixtures/attachment-storage";

const conversationId = "local:web:attachment-source";
const actor = webActorFromEmail("alice@example.com");

async function seed() {
  const storage = memoryAttachmentStorage();
  await getConversationStore().recordActivity({
    conversationId,
    actor: { email: actor.email },
    destination: { platform: "local", conversationId },
    visibility: "private",
    source: "web",
  });
  const attachment = await storeAttachment({
    conversationId,
    storage,
    db: getSqlExecutor(),
    file: {
      bytes: 5,
      data: Buffer.from("hello"),
      filename: "notes.txt",
      mimeType: "text/plain",
      path: "/tmp/notes.txt",
    },
  });
  await getConversationEventStore().append(conversationId, [
    {
      createdAtMs: 1,
      data: {
        type: "message",
        messageId: "user",
        role: "user",
        text: `Read this literal id: ${attachment.id}`,
        meta: {
          attachments: [
            {
              id: attachment.id,
              filename: "notes.txt",
              contentType: "text/plain",
              bytes: 5,
            },
          ],
        },
      },
    },
    {
      createdAtMs: 2,
      data: {
        type: "assistant_message",
        content: [{ type: "text", text: `Read ${attachment.id}` }],
        stopReason: "stop",
        timestamp: 2,
      },
    },
    {
      createdAtMs: 3,
      data: {
        type: "message",
        messageId: "assistant",
        role: "assistant",
        text: "Read the attachment.",
      },
    },
  ]);
  return { storage, attachment };
}

describe("fork attachment ownership", () => {
  afterEach(closeDb);
  it("copies files without blocking source writes or changing history, including nested forks", async () => {
    const { storage, attachment } = await seed();
    const historyBefore =
      await getConversationEventStore().loadHistory(conversationId);
    const concurrent = createPostgresJuniorSqlExecutor({
      connectionString: process.env.DATABASE_URL!,
      statementTimeoutMs: 1000,
    });
    const copying = {
      ...storage,
      get: async (key: string) => {
        await createSqlConversationEventStore(concurrent).append(
          conversationId,
          [
            {
              createdAtMs: 4,
              data: {
                type: "message",
                messageId: "concurrent",
                role: "user",
                text: "Source continues during copying",
              },
            },
          ],
        );
        return storage.get(key);
      },
      put: async (input: Parameters<typeof storage.put>[0]) => {
        await storage.put(input);
        // A retry wins publication while this request is still copying bytes.
        await forkConversationForViewer(
          testViewer(actor.email!),
          conversationId,
          { messageSeq: 2, idempotencyKey: "fork" },
          storage,
        );
      },
    };
    const fork = await forkConversationForViewer(
      testViewer(actor.email!),
      conversationId,
      { messageSeq: 2, idempotencyKey: "fork" },
      copying,
    ).finally(() => concurrent.close());
    const [copy] = await getDb()
      .select()
      .from(juniorAttachments)
      .where(eq(juniorAttachments.conversationId, fork.conversationId));
    expect(copy!.id).not.toBe(attachment.id);
    expect(storage.objects.size).toBe(2);
    const sourceFile = await readLiveAttachment({
      conversationId,
      attachmentId: attachment.id,
      db: getSqlExecutor(),
    });
    await storage.delete([sourceFile!.storageKey]);
    const copiedFile = await readLiveAttachment({
      conversationId: fork.conversationId,
      attachmentId: attachment.id,
      db: getSqlExecutor(),
    });
    expect(
      await new Response(await storage.get(copiedFile!.storageKey)).text(),
    ).toBe("hello");
    expect(
      await getConversationEventStore().loadHistory(fork.conversationId),
    ).toEqual(historyBefore);
    const nested = await forkConversationForViewer(
      testViewer(actor.email!),
      fork.conversationId,
      { messageSeq: 2, idempotencyKey: "nested" },
      storage,
    );
    expect(
      await readLiveAttachment({
        conversationId: nested.conversationId,
        attachmentId: attachment.id,
        db: getSqlExecutor(),
      }),
    ).not.toBeNull();
    expect(
      await readLiveAttachment({
        conversationId: nested.conversationId,
        attachmentId: copy!.id,
        db: getSqlExecutor(),
      }),
    ).not.toBeNull();
    expect(
      await getConversationEventStore().loadHistory(nested.conversationId),
    ).toEqual(historyBefore);
  });

  it("rolls back the fork and cleans up its objects when the copy fails", async () => {
    const { storage } = await seed();
    const before = await getConversationStore().listByActivity();
    const failingStorage = {
      ...storage,
      put: async (input: Parameters<typeof storage.put>[0]) => {
        await storage.put(input);
        throw new Error("Storage failed");
      },
    };
    await expect(
      forkConversationForViewer(
        testViewer(actor.email!),
        conversationId,
        { messageSeq: 2, idempotencyKey: "failure" },
        failingStorage,
      ),
    ).rejects.toThrow("Storage failed");
    expect(await getConversationStore().listByActivity()).toEqual(before);
    expect(storage.objects.size).toBe(1);
    expect(await getDb().select().from(juniorAttachments)).toHaveLength(1);
  });
  it("rechecks retention and cleans up unpublished bytes after a purge during copying", async () => {
    const { storage } = await seed();
    const copying = {
      ...storage,
      put: async (input: Parameters<typeof storage.put>[0]) => {
        await storage.put(input);
        await purgeConversationTree(getSqlExecutor(), {
          rootConversationId: conversationId,
          nowMs: Date.now(),
        });
      },
    };
    await expect(
      forkConversationForViewer(
        testViewer(actor.email!),
        conversationId,
        { messageSeq: 2, idempotencyKey: "purged" },
        copying,
      ),
    ).rejects.toThrow("Conversation history changed");
    expect(await getConversationStore().listByActivity()).toHaveLength(1);
    expect(storage.objects.size).toBe(1);
  });

  it("rechecks viewer access after file copying", async () => {
    const { storage } = await seed();
    await getDb().update(juniorDestinations).set({ visibility: "public" });
    const copying = {
      ...storage,
      put: async (input: Parameters<typeof storage.put>[0]) => {
        await storage.put(input);
        await getDb().update(juniorDestinations).set({ visibility: "private" });
      },
    };
    await expect(
      forkConversationForViewer(
        testViewer("other@example.com"),
        conversationId,
        { messageSeq: 2, idempotencyKey: "revoked" },
        copying,
      ),
    ).rejects.toThrow("Conversation not found");
    expect(await getConversationStore().listByActivity()).toHaveLength(1);
    expect(storage.objects.size).toBe(1);
  });
});
