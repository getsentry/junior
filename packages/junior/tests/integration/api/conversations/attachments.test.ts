import { MAX_ATTACHMENT_BYTES } from "@/chat/attachments/input";
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
import { filesInfoOk } from "../../../fixtures/slack/factories/api";
import {
  getCapturedSlackApiCalls,
  getCapturedSlackFileDownloadCalls,
  queueSlackApiError,
  queueSlackApiResponse,
  queueSlackPrivateFileDownload,
} from "../../../msw/handlers/slack-api";

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

/** Record a Slack conversation with one large file that Junior never stores. */
async function recordPendingSlackFile(
  slackFileId: string,
  visibility: "private" | "public" = "public",
) {
  const conversationId = `slack:C-${visibility}:pending-${slackFileId}`;
  await getConversationStore().recordActivity({
    conversationId,
    destination: {
      channelId: "CPENDING",
      platform: "slack",
      teamId: "TPUBLIC",
    },
    nowMs: 1,
    source: "slack",
    title: "Pending attachment conversation",
    visibility,
  });
  const storage = createMemoryAttachmentStorage();
  const stored = await storeAttachment({
    conversationId,
    db: getSqlExecutor(),
    file: {
      bytes: 30_000_000,
      deferred: true,
      filename: "standup.mp4",
      mimeType: "video/mp4",
      source: { provider: "slack", id: slackFileId },
    },
    storage,
  });
  return { conversationId, storage, stored };
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
        data: Buffer.from("hello image"),
        filename: "chart.png",
        mimeType: "image/png",
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
        data: Buffer.from("0123456789"),
        filename: "demo.mp4",
        mimeType: "video/mp4",
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

    // A same-window download link needs `attachment`, or some browsers
    // replace the page with the video.
    const saved = await app.request(
      `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/attachments/${stored.id}?download=true`,
    );
    expect(saved.status).toBe(200);
    expect(saved.headers.get("content-disposition")).toMatch(/^attachment;/);

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
        data: Buffer.alloc(0),
        filename: "empty.mp4",
        mimeType: "video/mp4",
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
        data: Buffer.from("secret"),
        filename: "notes.txt",
        mimeType: "text/plain",
        source: { provider: "slack", id: "FPRIVATE" },
      },
      storage,
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
    ).request("/api/conversations/attachment-uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bytes: 8,
        contentType: "image/png",
        conversationId,
        filename: "image.png",
        idempotencyKey: "outsider-upload",
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

  it("rejects unauthenticated, oversized, and empty input before storage", async () => {
    const storage = createMemoryAttachmentStorage();
    const upload = {
      bytes: 8,
      contentType: "image/png",
      filename: "image.png",
      idempotencyKey: "upload",
    };
    const request = (value: unknown) => ({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    });
    const uploadPath = "/api/conversations/attachment-uploads";
    expect(
      (
        await apiWithViewer(undefined, storage).request(
          uploadPath,
          request(upload),
        )
      ).status,
    ).toBe(401);
    const app = apiWithViewer("participant@example.com", storage);
    expect(
      (
        await app.request(
          uploadPath,
          request({ ...upload, bytes: MAX_ATTACHMENT_BYTES + 1 }),
        )
      ).status,
    ).toBe(400);
    const oversized = await app.request(
      `${uploadPath}/${crypto.randomUUID()}`,
      {
        body: new Uint8Array(MAX_ATTACHMENT_BYTES + 1),
        method: "PUT",
      },
    );
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({
      error: "Files must be 250 MB or less.",
    });
    expect(
      (
        await app.request(
          "/api/conversations",
          request({ message: "", idempotencyKey: "upload", uploadIds: [] }),
        )
      ).status,
    ).toBe(400);
    expect(storage.objects.size).toBe(0);
  });

  it("shows a large Slack file as pending in the transcript", async () => {
    const { conversationId, storage, stored } =
      await recordPendingSlackFile("FDEFERRED");
    await getConversationEventStore().append(conversationId, [
      {
        createdAtMs: 2,
        data: {
          type: "message",
          messageId: "slack-recording",
          role: "user",
          text: "Attached recording",
          meta: { source: "slack", slackFileIds: ["FDEFERRED"] },
        },
      },
    ]);
    const api = apiWithViewer(undefined, storage);

    const detail = await (
      await api.request(
        `http://localhost/api/conversations/${encodeURIComponent(conversationId)}`,
      )
    ).json();
    expect(detail.events[0].data.attachments).toEqual([
      {
        id: stored.id,
        filename: "standup.mp4",
        contentType: "video/mp4",
        bytes: 30_000_000,
        pending: true,
      },
    ]);
    expect(getCapturedSlackApiCalls("files.info")).toEqual([]);
  });

  it("streams a large Slack file from Slack on every download and never stores it", async () => {
    const { conversationId, storage, stored } =
      await recordPendingSlackFile("FSTREAMED");
    const body = "recording bytes";
    const url =
      "https://files.slack.com/files-pri/TPUBLIC-FSTREAMED/standup.mp4";
    for (let call = 0; call < 3; call += 1) {
      queueSlackApiResponse("files.info", {
        body: filesInfoOk({
          fileId: "FSTREAMED",
          size: body.length,
          urlPrivate: url,
        }),
      });
    }
    queueSlackPrivateFileDownload({ body });
    queueSlackPrivateFileDownload({ body });
    const api = apiWithViewer("viewer@example.com", storage);
    const path = `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/attachments/${stored.id}?download=true`;

    // HEAD asks Slack about the file but downloads nothing. The dashboard
    // uses it to learn why a download failed.
    const check = await api.request(path, { method: "HEAD" });
    expect(check.status).toBe(200);
    expect(getCapturedSlackFileDownloadCalls()).toEqual([]);

    for (let download = 0; download < 2; download += 1) {
      const response = await api.request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-disposition")).toMatch(
        /^attachment; filename="standup.mp4"/,
      );
      expect(response.headers.get("content-length")).toBe(String(body.length));
      expect(await response.text()).toBe(body);
    }
    expect(getCapturedSlackApiCalls("files.info")).toHaveLength(3);
    expect(getCapturedSlackFileDownloadCalls()).toEqual([
      expect.objectContaining({ url }),
      expect.objectContaining({ url }),
    ]);
    expect(storage.objects.size).toBe(0);
    const [row] = await getSqlExecutor()
      .db()
      .select({
        sha256: juniorAttachments.sha256,
        storageKey: juniorAttachments.storageKey,
      })
      .from(juniorAttachments)
      .where(eq(juniorAttachments.id, stored.id));
    expect(row).toEqual({ sha256: null, storageKey: null });
  });

  it("reports a deleted Slack file when the dashboard asks for it", async () => {
    const { conversationId, storage, stored } =
      await recordPendingSlackFile("FDELETED");
    queueSlackApiError("files.info", { error: "file_not_found" });
    queueSlackApiError("files.info", { error: "file_not_found" });
    const api = apiWithViewer("viewer@example.com", storage);
    const path = `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/attachments/${stored.id}`;

    const check = await api.request(path, { method: "HEAD" });
    const response = await api.request(path);

    expect(check.status).toBe(409);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error:
        "standup.mp4 is no longer available: The Slack file was deleted, or Junior can no longer access it.",
    });
    expect(getCapturedSlackFileDownloadCalls()).toEqual([]);
  });

  it("refuses a Slack download for viewers who cannot see the conversation", async () => {
    const { conversationId, storage, stored } = await recordPendingSlackFile(
      "FPRIVATEPENDING",
      "private",
    );
    const path = `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/attachments/${stored.id}`;

    const outsider = await apiWithViewer(
      "outsider@example.com",
      storage,
    ).request(path);
    const anonymous = await apiWithViewer(undefined, storage).request(path);

    expect(outsider.status).toBe(404);
    expect(anonymous.status).toBe(404);
    expect(getCapturedSlackApiCalls("files.info")).toEqual([]);
    expect(getCapturedSlackFileDownloadCalls()).toEqual([]);
  });

  it("needs a signed-in viewer for a Slack download in a public conversation", async () => {
    const { conversationId, storage, stored } =
      await recordPendingSlackFile("FPUBLICANON");
    const path = `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/attachments/${stored.id}?download=true`;
    const anonymous = apiWithViewer(undefined, storage);

    const check = await anonymous.request(path, { method: "HEAD" });
    const response = await anonymous.request(path);

    expect(check.status).toBe(401);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "Authentication required.",
    });
    expect(getCapturedSlackApiCalls("files.info")).toEqual([]);
    expect(getCapturedSlackFileDownloadCalls()).toEqual([]);
  });

  it("starts a Slack download only from a row in the requested conversation", async () => {
    const here = await recordPendingSlackFile("FHERE");
    const elsewhere = await recordPendingSlackFile("FELSEWHERE");
    const api = apiWithViewer("viewer@example.com", here.storage);
    const base = `http://localhost/api/conversations/${encodeURIComponent(here.conversationId)}/attachments`;

    // A row id from another conversation, a raw Slack file id, and an
    // unknown id all miss the conversation-scoped lookup.
    for (const attachmentId of [
      elsewhere.stored.id,
      "FELSEWHERE",
      "att_unknown",
    ]) {
      const response = await api.request(`${base}/${attachmentId}`);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Attachment not found." });
    }
    expect(getCapturedSlackApiCalls("files.info")).toEqual([]);
    expect(getCapturedSlackFileDownloadCalls()).toEqual([]);
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
        data: Buffer.from("gone"),
        filename: "old.txt",
        mimeType: "text/plain",
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
