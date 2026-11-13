import { AwsClient } from "aws4fetch";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createConversationRoutes } from "@/api/conversations/routes";
import type { JuniorApiEnv } from "@/api/route";
import { readAttachmentStorageConfig } from "@/chat/attachments/config";
import {
  bufferBody,
  createAttachmentStorage,
  type AttachmentStorage,
} from "@/chat/attachments/storage";
import {
  ATTACHMENT_RETENTION_MS,
  collectAttachmentGarbage,
  readLiveAttachment,
  requestAttachmentDeletion,
  storeAttachment,
} from "@/chat/attachments/store";
import { closeDb, getConversationStore, getSqlExecutor } from "@/chat/db";
import { juniorAttachments } from "@/db/schema";
import { createConversationWorkQueueTestAdapter } from "../fixtures/conversation-work";

// The `s3` service in compose.yaml and in CI runs versitygw on this port.
const S3_ENDPOINT = "http://localhost:7072";
const S3_ACCESS_KEY_ID = "junior";
const S3_SECRET_ACCESS_KEY = "junior-secret";
const S3_BUCKET = `junior-test-${process.pid}-${Date.now()}`;

const bucketClient = new AwsClient({
  accessKeyId: S3_ACCESS_KEY_ID,
  region: "us-east-1",
  secretAccessKey: S3_SECRET_ACCESS_KEY,
  service: "s3",
});

async function sendBucketRequest(method: "DELETE" | "PUT"): Promise<void> {
  const response = await bucketClient.fetch(`${S3_ENDPOINT}/${S3_BUCKET}`, {
    method,
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`S3 bucket ${method} failed: ${response.status} ${body}`);
  }
}

function chunkedBody(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  });
}

function s3Storage(secretAccessKey = S3_SECRET_ACCESS_KEY) {
  return createAttachmentStorage(
    readAttachmentStorageConfig({
      JUNIOR_ATTACHMENT_STORAGE_PROVIDER: "s3",
      JUNIOR_S3_ACCESS_KEY_ID: S3_ACCESS_KEY_ID,
      JUNIOR_S3_BUCKET: S3_BUCKET,
      JUNIOR_S3_ENDPOINT: S3_ENDPOINT,
      JUNIOR_S3_SECRET_ACCESS_KEY: secretAccessKey,
    }),
  );
}

async function recordPublicConversation(conversationId: string) {
  await getConversationStore().recordActivity({
    conversationId,
    destination: { channelId: "CS3", platform: "slack", teamId: "TS3" },
    nowMs: 1,
    source: "slack",
    title: "S3 attachment conversation",
    visibility: "public",
  });
}

describe("S3 attachment storage", () => {
  beforeAll(async () => {
    await sendBucketRequest("PUT");
  });

  afterEach(async () => {
    await closeDb();
  });

  afterAll(async () => {
    await sendBucketRequest("DELETE");
  });

  // Higher-level tests use memory storage. Keep it in step with a real
  // S3-compatible server for the behavior those tests depend on.
  it.each([
    ["memory", () => createAttachmentStorage({ provider: "memory" })],
    ["s3", () => s3Storage()],
  ])(
    "%s storage round trips bytes and byte ranges and treats missing keys as absent",
    async (_provider, create) => {
      const storage = create();
      const key = `contract/${Date.now()}/file.bin`;
      const body = Buffer.from([0, 1, 2, 255]);

      // Two chunks: the body streams to storage, it is not one buffer.
      await storage.put({
        body: chunkedBody([body.subarray(0, 2), body.subarray(2)]),
        bytes: body.byteLength,
        contentType: "application/octet-stream",
        key,
      });
      const stored = await storage.get(key);
      expect(Buffer.from(await new Response(stored).arrayBuffer())).toEqual(
        body,
      );
      const ranged = await storage.get(key, { start: 1, end: 2 });
      expect(Buffer.from(await new Response(ranged).arrayBuffer())).toEqual(
        Buffer.from([1, 2]),
      );

      await storage.delete([key, `${key}.missing`]);
      await expect(storage.get(key)).resolves.toBeNull();
      await expect(storage.delete([])).resolves.toBeUndefined();
    },
  );

  it("signs a browser upload that only fits the declared size and type", async () => {
    const storage = s3Storage();
    const key = `uploads/${Date.now()}`;
    const body = Buffer.from("deploy failed");
    const target = await storage.createUploadTarget!({
      bytes: body.byteLength,
      contentType: "text/plain",
      expiresAtMs: Date.now() + 60_000,
      key,
    });
    const send = (data: Buffer, contentType = "text/plain") =>
      fetch(target.url, {
        body: new Uint8Array(data),
        headers: { ...target.headers, "content-type": contentType },
        method: target.method,
      }).then(async (response) => {
        await response.arrayBuffer();
        return response.status;
      });

    expect(await send(Buffer.from("other size"))).toBe(403);
    expect(await send(body, "text/html")).toBe(403);
    expect(await send(body)).toBe(200);
    expect(await send(Buffer.from("other bytes!!"))).toBe(412);
    const stored = await storage.get(key);
    expect(await new Response(stored).text()).toBe("deploy failed");
    await storage.delete([key]);
  });

  it("serves stored attachments and deletes them during garbage collection", async () => {
    const conversationId = "slack:CS3:attachment";
    await recordPublicConversation(conversationId);
    const storage = s3Storage();
    const db = getSqlExecutor();
    const stored = await storeAttachment({
      conversationId,
      db,
      file: {
        data: Buffer.from("hello image"),
        // Storage keys hold the filename. Symbols must round-trip through S3.
        filename: "chart (final) #1+ü.png",
        mimeType: "image/png",
      },
      storage,
    });
    const app = new Hono<JuniorApiEnv>().route(
      "/api/conversations",
      createConversationRoutes({
        attachmentStorage: storage,
        queue: createConversationWorkQueueTestAdapter(),
      }),
    );

    const response = await app.request(
      `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/attachments/${stored.id}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(await response.text()).toBe("hello image");

    const record = await readLiveAttachment({
      attachmentId: stored.id,
      conversationId,
      db,
    });
    await requestAttachmentDeletion(db, [conversationId], Date.now());
    await expect(
      collectAttachmentGarbage({ db, nowMs: Date.now(), storage }),
    ).resolves.toEqual({ deleted: 1 });
    await expect(storage.get(record!.storageKey!)).resolves.toBeNull();
  });

  it("streams a sourced file and keeps nothing when its size is wrong", async () => {
    const conversationId = "slack:CS3:stream";
    await recordPublicConversation(conversationId);
    const storage = s3Storage();
    const db = getSqlExecutor();
    const chunks = () => [Buffer.from("deploy "), Buffer.from("failed")];
    const opens = new Map<number, number>();
    const file = (bytes: number) => ({
      bytes,
      filename: "deploy.log",
      mimeType: "text/plain",
      open: async () => {
        opens.set(bytes, (opens.get(bytes) ?? 0) + 1);
        return chunkedBody(chunks());
      },
      source: { id: `F${bytes}`, provider: "slack" },
    });

    const stored = await storeAttachment({
      conversationId,
      db,
      file: file(13),
      storage,
    });
    const record = await readLiveAttachment({
      attachmentId: stored.id,
      conversationId,
      db,
    });
    expect(record?.bytes).toBe(13);
    const body = await storage.get(record!.storageKey!);
    expect(await new Response(body).text()).toBe("deploy failed");

    // A body shorter or longer than its declared size fails the write, and
    // no row is kept. S3 refuses the short body like a dropped upload, so
    // the store tries it again with a fresh body. A long body fails once.
    await expect(
      storeAttachment({ conversationId, db, file: file(20), storage }),
    ).rejects.toThrow("fetch failed");
    expect(opens.get(20)).toBe(3);
    await expect(
      storeAttachment({ conversationId, db, file: file(5), storage }),
    ).rejects.toThrow("does not match its declared 5 bytes");
    expect(opens.get(5)).toBe(1);
    const rows = await db
      .db()
      .select({ id: juniorAttachments.id })
      .from(juniorAttachments)
      .where(eq(juniorAttachments.conversationId, conversationId));
    expect(rows).toEqual([{ id: stored.id }]);
    await storage.delete([record!.storageKey!]);
  });

  it("writes a streamed file again with a fresh body after a failed put", async () => {
    const conversationId = "slack:CS3:retry";
    await recordPublicConversation(conversationId);
    const s3 = s3Storage();
    let puts = 0;
    const storage: AttachmentStorage = {
      ...s3,
      async put(input) {
        puts += 1;
        if (puts === 1) {
          // Read part of the body, then fail like a dropped connection.
          await input.body.getReader().read();
          throw new Error("S3 put failed with status 503");
        }
        await s3.put(input);
      },
    };
    let opens = 0;
    const stored = await storeAttachment({
      conversationId,
      db: getSqlExecutor(),
      file: {
        bytes: 13,
        filename: "deploy.log",
        mimeType: "text/plain",
        open: async () => {
          opens += 1;
          return chunkedBody([Buffer.from("deploy "), Buffer.from("failed")]);
        },
        source: { id: "FRETRY", provider: "slack" },
      },
      storage,
    });

    expect({ opens, puts }).toEqual({ opens: 2, puts: 2 });
    const record = await readLiveAttachment({
      attachmentId: stored.id,
      conversationId,
      db: getSqlExecutor(),
    });
    expect(record?.bytes).toBe(13);
    const body = await s3.get(record!.storageKey!);
    expect(await new Response(body).text()).toBe("deploy failed");
    await s3.delete([record!.storageKey!]);
  });

  it("records a large Slack file with no object, and GC deletes its row", async () => {
    const conversationId = "slack:CS3:deferred";
    await recordPublicConversation(conversationId);
    const storage = s3Storage();
    const db = getSqlExecutor();
    const deferred = await storeAttachment({
      conversationId,
      db,
      file: {
        bytes: 13,
        deferred: true,
        filename: "standup.mp4",
        mimeType: "video/mp4",
        source: { id: "FDEFERRED", provider: "slack" },
      },
      storage,
    });
    const stored = await storeAttachment({
      conversationId,
      db,
      file: {
        data: Buffer.from("deploy failed"),
        filename: "deploy.log",
        mimeType: "text/plain",
      },
      storage,
    });
    const deferredRow = await readLiveAttachment({
      attachmentId: deferred.id,
      conversationId,
      db,
    });
    expect(deferredRow?.storageKey).toBeNull();
    const storedRow = await readLiveAttachment({
      attachmentId: stored.id,
      conversationId,
      db,
    });

    // After the retention period, GC deletes the one object and both rows.
    await expect(
      collectAttachmentGarbage({
        db,
        nowMs: Date.now() + ATTACHMENT_RETENTION_MS + 1,
        storage,
      }),
    ).resolves.toEqual({ deleted: 2 });
    await expect(storage.get(storedRow!.storageKey!)).resolves.toBeNull();
    await expect(
      readLiveAttachment({ attachmentId: deferred.id, conversationId, db }),
    ).resolves.toBeNull();
  });

  it("rejects filenames that would leave the attachment key prefix", async () => {
    const conversationId = "slack:CS3:traversal";
    await recordPublicConversation(conversationId);
    const storage = s3Storage();
    const artifactKey = "artifacts/existing.png";
    await storage.put({
      body: bufferBody(Buffer.from("artifact")),
      bytes: 8,
      contentType: "image/png",
      key: artifactKey,
    });

    await expect(
      storeAttachment({
        conversationId,
        db: getSqlExecutor(),
        file: {
          data: Buffer.from("evil"),
          filename: "../../../../../artifacts/existing.png",
          mimeType: "image/png",
        },
        storage,
      }),
    ).rejects.toThrow("S3 object keys cannot contain . or .. path segments");

    const artifact = await storage.get(artifactKey);
    expect(await new Response(artifact).text()).toBe("artifact");
    await storage.delete([artifactKey]);
  });

  it("fails writes with rejected credentials without exposing the key", async () => {
    const conversationId = "slack:CS3:bad-credentials";
    await recordPublicConversation(conversationId);

    const write = storeAttachment({
      conversationId,
      db: getSqlExecutor(),
      file: {
        data: Buffer.from("secret"),
        filename: "private-name.txt",
        mimeType: "text/plain",
      },
      storage: s3Storage("wrong-secret"),
    });

    await expect(write).rejects.toThrow("S3 put failed with status 403");
    await expect(write).rejects.not.toThrow("private-name");
  });
});
