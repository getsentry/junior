import { AwsClient } from "aws4fetch";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createConversationRoutes } from "@/api/conversations/routes";
import type { JuniorApiEnv } from "@/api/route";
import { readAttachmentStorageConfig } from "@/chat/attachments/config";
import { createAttachmentStorage } from "@/chat/attachments/storage";
import {
  collectAttachmentGarbage,
  readLiveAttachment,
  requestAttachmentDeletion,
  storeAttachment,
} from "@/chat/attachments/store";
import { closeDb, getConversationStore, getSqlExecutor } from "@/chat/db";
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

  it("serves stored attachments and deletes them during garbage collection", async () => {
    const conversationId = "slack:CS3:attachment";
    await recordPublicConversation(conversationId);
    const storage = s3Storage();
    const db = getSqlExecutor();
    const stored = await storeAttachment({
      conversationId,
      db,
      file: {
        bytes: 11,
        data: Buffer.from("hello image"),
        // Storage keys hold the filename. Symbols must round-trip through S3.
        filename: "chart (final) #1+ü.png",
        mimeType: "image/png",
        path: "/tmp/chart.png",
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
    await expect(storage.get(record!.storageKey)).resolves.toBeNull();
  });

  it("rejects filenames that would leave the attachment key prefix", async () => {
    const conversationId = "slack:CS3:traversal";
    await recordPublicConversation(conversationId);
    const storage = s3Storage();
    const artifactKey = "artifacts/existing.png";
    await storage.put({
      body: Buffer.from("artifact"),
      contentType: "image/png",
      key: artifactKey,
    });

    await expect(
      storeAttachment({
        conversationId,
        db: getSqlExecutor(),
        file: {
          bytes: 4,
          data: Buffer.from("evil"),
          filename: "../../../../../artifacts/existing.png",
          mimeType: "image/png",
          path: "/tmp/evil.png",
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
        bytes: 6,
        data: Buffer.from("secret"),
        filename: "private-name.txt",
        mimeType: "text/plain",
        path: "/tmp/private-name.txt",
      },
      storage: s3Storage("wrong-secret"),
    });

    await expect(write).rejects.toThrow("S3 put failed with status 403");
    await expect(write).rejects.not.toThrow("private-name");
  });
});
