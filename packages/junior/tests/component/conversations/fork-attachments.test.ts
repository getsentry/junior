import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { forkConversation } from "@/chat/conversations/fork";
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
        text: "Read this",
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
  it("copies attachment bytes and references so deleting the source does not remove the fork file", async () => {
    const { storage, attachment } = await seed();
    const fork = await forkConversation({
      actor,
      attachmentStorage: storage,
      conversationId,
      messageSeq: 2,
      idempotencyKey: "fork",
      visibility: "private",
    });
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
      attachmentId: copy!.id,
      db: getSqlExecutor(),
    });
    expect(
      await new Response(await storage.get(copiedFile!.storageKey)).text(),
    ).toBe("hello");
    const history = JSON.stringify(
      await getConversationEventStore().loadHistory(fork.conversationId),
    );
    expect(history).toContain(copy!.id);
    expect(history).not.toContain(attachment.id);
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
      forkConversation({
        actor,
        attachmentStorage: failingStorage,
        conversationId,
        messageSeq: 2,
        idempotencyKey: "failure",
        visibility: "private",
      }),
    ).rejects.toThrow("Storage failed");
    expect(await getConversationStore().listByActivity()).toEqual(before);
    expect(storage.objects.size).toBe(1);
    expect(await getDb().select().from(juniorAttachments)).toHaveLength(1);
  });
});
