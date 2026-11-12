import { createMemoryAttachmentStorage } from "@/chat/attachments/memory";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createConversationWorkQueueTestAdapter } from "../../../fixtures/conversation-work";
import { createConversationRoutes } from "@/api/conversations/routes";
import type { JuniorApiEnv } from "@/api/route";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import { storeAttachment } from "@/chat/attachments/store";
import {
  closeDb,
  getConversationStore,
  getSqlExecutor,
  getConversationEventStore,
} from "@/chat/db";
import { juniorAttachments } from "@/db/schema";
import { signedInViewer } from "../../../fixtures/user";

function apiWithViewer(
  email: string | undefined,
  storage: AttachmentStorage,
): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();
  if (email) {
    app.use("*", async (context, next) => {
      context.set("viewer", await signedInViewer(email));
      await next();
    });
  }
  app.route(
    "/api/conversations",
    createConversationRoutes({
      attachmentStorage: storage,
      queue: createConversationWorkQueueTestAdapter(),
    }),
  );
  return app;
}

describe("conversation attachment API", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("returns attachment bytes for public conversations", async () => {
    const conversationId = "slack:C-public:attachment";
    await getConversationStore().recordActivity({
      conversationId,
      destination: {
        channelId: "CPUBLIC",
        platform: "slack",
        teamId: "TPUBLIC",
      },
      nowMs: 1,
      source: "slack",
      title: "Public attachment conversation",
      visibility: "public",
    });
    const storage = createMemoryAttachmentStorage();
    const stored = await storeAttachment({
      conversationId,
      db: getSqlExecutor(),
      file: {
        bytes: 11,
        data: Buffer.from("hello image"),
        filename: "chart.png",
        mimeType: "image/png",
        path: "/tmp/chart.png",
      },
      storage,
    });

    const response = await apiWithViewer(undefined, storage).request(
      `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/attachments/${stored.id}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toContain("chart.png");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-length")).toBe("11");
    expect(await response.text()).toBe("hello image");
  });

  it("serves one byte range so media players can play and seek", async () => {
    const conversationId = "slack:C-public:video-attachment";
    await getConversationStore().recordActivity({
      conversationId,
      destination: {
        channelId: "CPUBLIC",
        platform: "slack",
        teamId: "TPUBLIC",
      },
      nowMs: 1,
      source: "slack",
      title: "Video attachment conversation",
      visibility: "public",
    });
    const storage = createMemoryAttachmentStorage();
    const stored = await storeAttachment({
      conversationId,
      db: getSqlExecutor(),
      file: {
        bytes: 10,
        data: Buffer.from("0123456789"),
        filename: "demo.mp4",
        mimeType: "video/mp4",
        path: "/tmp/demo.mp4",
      },
      storage,
    });
    const app = apiWithViewer(undefined, storage);
    const read = (range?: string) =>
      app.request(
        `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/attachments/${stored.id}`,
        range ? { headers: { range } } : undefined,
      );

    const whole = await read();
    expect(whole.status).toBe(200);
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    expect(whole.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(await whole.text()).toBe("0123456789");

    // Safari probes with `bytes=0-1` before it plays a video.
    for (const [range, body, contentRange] of [
      ["bytes=0-1", "01", "bytes 0-1/10"],
      ["bytes=4-", "456789", "bytes 4-9/10"],
      ["bytes=-3", "789", "bytes 7-9/10"],
      ["bytes=8-99", "89", "bytes 8-9/10"],
    ] as const) {
      const partial = await read(range);
      expect(partial.status).toBe(206);
      expect(partial.headers.get("content-range")).toBe(contentRange);
      expect(partial.headers.get("content-length")).toBe(String(body.length));
      expect(partial.headers.get("content-type")).toBe("video/mp4");
      expect(await partial.text()).toBe(body);
    }

    const unsatisfiable = await read("bytes=10-");
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get("content-range")).toBe("bytes */10");

    const empty = await storeAttachment({
      conversationId,
      db: getSqlExecutor(),
      file: {
        bytes: 0,
        data: Buffer.alloc(0),
        filename: "empty.mp4",
        mimeType: "video/mp4",
        path: "/tmp/empty.mp4",
      },
      storage,
    });
    const emptySuffix = await app.request(
      `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/attachments/${empty.id}`,
      { headers: { range: "bytes=-3" } },
    );
    expect(emptySuffix.status).toBe(416);
    expect(emptySuffix.headers.get("content-range")).toBe("bytes */0");

    // HTTP lets a server ignore a range header it does not support.
    for (const range of ["bytes=0-1,4-5", "bytes=5-2", "items=0-1"]) {
      const ignored = await read(range);
      expect(ignored.status).toBe(200);
      expect(await ignored.text()).toBe("0123456789");
    }
  });

  it("returns attachment bytes only to private-conversation participants", async () => {
    const conversationId = "slack:C-private:attachment";
    await getConversationStore().recordActivity({
      actor: {
        email: "participant@example.com",
        platform: "slack",
        slackUserId: "U-participant",
        teamId: "TPRIVATE",
      },
      conversationId,
      destination: {
        channelId: "CPRIVATE",
        platform: "slack",
        teamId: "TPRIVATE",
      },
      nowMs: 1,
      source: "slack",
      title: "Private attachment conversation",
      visibility: "private",
    });
    const storage = createMemoryAttachmentStorage();
    const stored = await storeAttachment({
      conversationId,
      db: getSqlExecutor(),
      file: {
        bytes: 6,
        data: Buffer.from("secret"),
        filename: "notes.txt",
        mimeType: "text/plain",
        path: "/tmp/notes.txt",
      },
      storage,
      source: { provider: "slack", id: "FPRIVATE" },
    });
    await getConversationEventStore().append(conversationId, [
      {
        createdAtMs: 2,
        data: {
          type: "message",
          messageId: "slack-image",
          role: "user",
          text: "Attached notes",
          meta: { source: "slack", slackFileIds: ["FPRIVATE"] },
        },
      },
    ]);
    const detailPath = `http://localhost/api/conversations/${encodeURIComponent(conversationId)}`;
    const visible = await (
      await apiWithViewer("participant@example.com", storage).request(
        detailPath,
      )
    ).json();
    expect(visible.events[0].data.attachments).toEqual([
      {
        id: stored.id,
        filename: "notes.txt",
        contentType: "text/plain",
        bytes: 6,
      },
    ]);
    const hidden = await (
      await apiWithViewer("outsider@example.com", storage).request(detailPath)
    ).json();
    expect(hidden.events[0].data.attachments).toBeUndefined();
    expect(hidden.events[0].data.redacted).toBe(true);
    const rejectedWrite = await apiWithViewer(
      "outsider@example.com",
      storage,
    ).request(`${detailPath}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "Upload",
        idempotencyKey: "outsider-upload",
        images: [
          {
            filename: "image.png",
            contentType: "image/png",
            data: "iVBORw0KGgo=",
          },
        ],
      }),
    });
    expect(rejectedWrite.status).toBe(403);
    expect(storage.objects.size).toBe(1);

    const path = `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/attachments/${stored.id}`;

    const anonymous = await apiWithViewer(undefined, storage).request(path);
    expect(anonymous.status).toBe(404);

    const outsider = await apiWithViewer(
      "outsider@example.com",
      storage,
    ).request(path);
    expect(outsider.status).toBe(404);

    const participant = await apiWithViewer(
      "participant@example.com",
      storage,
    ).request(path);
    expect(participant.status).toBe(200);
    expect(participant.headers.get("content-type")).toBe("text/plain");
    expect(participant.headers.get("content-disposition")).toContain(
      "attachment",
    );
    expect(await participant.text()).toBe("secret");
  });

  it("rejects unauthenticated, unsupported, and oversized image input before storage", async () => {
    const storage = createMemoryAttachmentStorage();
    const body = {
      message: "",
      idempotencyKey: "upload",
      images: [
        {
          filename: "image.png",
          contentType: "image/png",
          data: Buffer.from("not an image").toString("base64"),
        },
      ],
    };
    const request = (value: unknown) => ({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    });
    expect(
      (
        await apiWithViewer(undefined, storage).request(
          "/api/conversations",
          request(body),
        )
      ).status,
    ).toBe(401);
    const app = apiWithViewer("participant@example.com", storage);
    const invalid = await app.request("/api/conversations", request(body));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: "Use PNG, JPEG, GIF, or WebP image files.",
    });
    expect(
      (
        await app.request(
          "/api/conversations",
          request({
            ...body,
            images: [{ ...body.images[0], data: "a".repeat(4_450_001) }],
          }),
        )
      ).status,
    ).toBe(413);
    expect(
      (
        await app.request(
          "/api/conversations",
          request({ ...body, images: [] }),
        )
      ).status,
    ).toBe(400);
    expect(storage.objects.size).toBe(0);
  });

  it("hides purge-marked attachments", async () => {
    const conversationId = "slack:C-public:purged-attachment";
    await getConversationStore().recordActivity({
      conversationId,
      destination: {
        channelId: "CPUBLIC",
        platform: "slack",
        teamId: "TPUBLIC",
      },
      nowMs: 1,
      source: "slack",
      title: "Purged attachment conversation",
      visibility: "public",
    });
    const storage = createMemoryAttachmentStorage();
    const stored = await storeAttachment({
      conversationId,
      db: getSqlExecutor(),
      file: {
        bytes: 4,
        data: Buffer.from("gone"),
        filename: "old.txt",
        mimeType: "text/plain",
        path: "/tmp/old.txt",
      },
      storage,
    });
    await getSqlExecutor()
      .db()
      .update(juniorAttachments)
      .set({ deleteRequestedAt: new Date(2) })
      .where(eq(juniorAttachments.id, stored.id));

    const response = await apiWithViewer(undefined, storage).request(
      `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/attachments/${stored.id}`,
    );
    expect(response.status).toBe(404);
  });
});
