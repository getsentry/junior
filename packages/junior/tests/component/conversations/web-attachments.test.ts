import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createConversationRoutes } from "@/api/conversations/routes";
import type { JuniorApiEnv } from "@/api/route";
import { attachmentUploadSchema } from "@/api/schema";
import { createMemoryAttachmentStorage } from "@/chat/attachments/memory";
import { loadInputAttachments } from "@/chat/attachments/model-input";
import { collectAttachmentUploadGarbage } from "@/chat/attachments/uploads";
import { getSqlExecutor } from "@/chat/db";
import {
  createConversationFixture,
  closeConversationFixture,
} from "../../fixtures/conversation";
import { signedInViewer } from "../../fixtures/user";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU1sAAAAASUVORK5CYII=",
  "base64",
);
const HOUR_MS = 60 * 60 * 1000;

async function createWebApp() {
  const fixture = await createConversationFixture();
  const storage = createMemoryAttachmentStorage();
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    const email = context.req.header("x-test-viewer");
    if (email) context.set("viewer", await signedInViewer(email));
    await next();
  });
  app.route(
    "/api/conversations",
    createConversationRoutes({
      attachmentStorage: storage,
      queue: fixture.queue,
    }),
  );
  const json = (email: string) => ({
    "content-type": "application/json",
    "x-test-viewer": email,
  });
  const owner = fixture.actor.email;
  type UploadFile = {
    body: Buffer;
    contentType: string;
    filename: string;
    idempotencyKey: string;
  };
  /** Ask for one upload like the browser does. */
  const reserve = async (file: UploadFile) => {
    const response = await app.request(
      "/api/conversations/attachment-uploads",
      {
        body: JSON.stringify({
          bytes: file.body.byteLength,
          contentType: file.contentType,
          filename: file.filename,
          idempotencyKey: file.idempotencyKey,
        }),
        headers: json(owner),
        method: "POST",
      },
    );
    expect(response.status).toBe(200);
    return attachmentUploadSchema.parse(await response.json());
  };
  /** Reserve one upload, then write its bytes. */
  const upload = async (file: UploadFile) => {
    const { target, uploadId } = await reserve(file);
    const put = await app.request(target.url, {
      body: new Uint8Array(file.body),
      headers: { ...target.headers, "x-test-viewer": owner },
      method: target.method,
    });
    expect(put.status).toBe(204);
    return uploadId;
  };
  return { app, fixture, json, owner, reserve, storage, upload };
}

describe("web attachment input", () => {
  afterEach(closeConversationFixture);

  it("sends uploaded files by id and shows them only to participants", async () => {
    const { app, fixture, json, owner, storage, upload } = await createWebApp();
    const idempotencyKey = "upload-create";
    const uploadIds = [
      await upload({
        body: png,
        contentType: "image/png",
        filename: "pixel.png",
        idempotencyKey,
      }),
      await upload({
        body: Buffer.from("deploy failed\n"),
        contentType: "text/plain",
        filename: "build.log",
        idempotencyKey,
      }),
      // The browser guesses the type from the name. Only bytes make an image.
      await upload({
        body: Buffer.from("not a png"),
        contentType: "image/png",
        filename: "fake.png",
        idempotencyKey,
      }),
    ];
    const create = () =>
      app.request("/api/conversations", {
        body: JSON.stringify({
          idempotencyKey,
          message: "",
          uploadIds,
          visibility: "private",
        }),
        headers: json(owner),
        method: "POST",
      });
    const accepted = await (await create()).json();
    expect(accepted.status).toBe("accepted");
    // A retry is the same Message with the same attachments.
    expect(await (await create()).json()).toEqual({
      ...accepted,
      status: "duplicate",
    });
    expect(storage.objects.size).toBe(3);
    // A sent file keeps its bytes.
    const rewrite = await app.request(
      `/api/conversations/attachment-uploads/${uploadIds[0]}`,
      {
        body: new Uint8Array(png),
        headers: { "x-test-viewer": owner },
        method: "PUT",
      },
    );
    expect(await rewrite.json()).toEqual({ error: "Upload was already sent." });

    const base = `/api/conversations/${encodeURIComponent(accepted.conversationId)}`;
    const pending = await (
      await app.request(`${base}/pending-messages`, { headers: json(owner) })
    ).json();
    expect(pending.messages).toHaveLength(1);
    expect(pending.messages[0].attachments).toEqual([
      {
        id: uploadIds[0],
        filename: "pixel.png",
        contentType: "image/png",
        bytes: png.byteLength,
      },
      {
        id: uploadIds[1],
        filename: "build.log",
        contentType: "text/plain",
        bytes: 14,
      },
      {
        id: uploadIds[2],
        filename: "fake.png",
        contentType: "application/octet-stream",
        bytes: 9,
      },
    ]);
    const outsider = await (
      await app.request(`${base}/pending-messages`, {
        headers: json("other@example.com"),
      })
    ).json();
    expect(outsider.messages[0]).toMatchObject({ redacted: true });
    expect(outsider.messages[0].attachments).toBeUndefined();

    // Like Slack: a small image goes to the model, other files point to
    // loadAttachment.
    const input = await loadInputAttachments({
      attachments: pending.messages[0].attachments,
      conversationId: accepted.conversationId,
      storage,
    });
    expect(input[0]).toMatchObject({ mediaType: "image/png", data: png });
    expect(input[1]?.data).toBeUndefined();
    expect(input[1]?.promptText).toContain(`attachment_id: ${uploadIds[1]}`);
    expect(input[1]?.promptText).toContain("Use loadAttachment");
    expect(input[2]?.data).toBeUndefined();
    expect(fixture.queue.queuedMessages()).toHaveLength(1);
  });

  it("rejects uploads that the Message cannot use", async () => {
    const { app, fixture, json, owner, reserve, upload } = await createWebApp();
    const send = (idempotencyKey: string, uploadIds: string[]) =>
      app.request("/api/conversations", {
        body: JSON.stringify({ idempotencyKey, message: "Look", uploadIds }),
        headers: json(owner),
        method: "POST",
      });

    const { uploadId: unwritten } = await reserve({
      body: png,
      contentType: "image/png",
      filename: "pixel.png",
      idempotencyKey: "unwritten",
    });
    const otherMessage = await upload({
      body: png,
      contentType: "image/png",
      filename: "pixel.png",
      idempotencyKey: "first",
    });
    expect((await (await send("unwritten", [unwritten])).json()).error).toBe(
      "Upload of pixel.png is not complete. Attach it again.",
    );
    // An upload belongs to one Message idempotency key and one viewer.
    expect((await send("second", [otherMessage])).status).toBe(400);
    const outsiderUpload = await app.request(
      "/api/conversations/attachment-uploads",
      {
        body: JSON.stringify({
          bytes: png.byteLength,
          contentType: "image/png",
          conversationId: "local:web:not-yours",
          filename: "pixel.png",
          idempotencyKey: "first",
        }),
        headers: json(owner),
        method: "POST",
      },
    );
    expect(outsiderUpload.status).toBe(404);
    expect(fixture.queue.queuedMessages()).toHaveLength(0);
  });

  it("sends only small images to the model and deletes unsent uploads", async () => {
    const { app, json, owner, storage, upload } = await createWebApp();
    const large = Buffer.concat([png, Buffer.alloc(6 * 1024 * 1024)]);
    const idempotencyKey = "large-image";
    const uploadId = await upload({
      body: large,
      contentType: "image/png",
      filename: "large.png",
      idempotencyKey,
    });
    const unsent = await upload({
      body: png,
      contentType: "image/png",
      filename: "unsent.png",
      idempotencyKey: "never-sent",
    });
    const accepted = await (
      await app.request("/api/conversations", {
        body: JSON.stringify({
          idempotencyKey,
          message: "",
          uploadIds: [uploadId],
        }),
        headers: json(owner),
        method: "POST",
      })
    ).json();
    const [input] = await loadInputAttachments({
      attachments: [
        {
          id: uploadId,
          filename: "large.png",
          contentType: "image/png",
          bytes: large.byteLength,
        },
      ],
      conversationId: accepted.conversationId,
      storage,
    });
    expect(input?.data).toBeUndefined();
    expect(input?.promptText).toContain(`attachment_id: ${uploadId}`);

    expect(storage.objects.size).toBe(2);
    await collectAttachmentUploadGarbage({
      db: getSqlExecutor(),
      nowMs: Date.now() + 25 * HOUR_MS,
      storage,
    });
    // The sent file belongs to its attachment now. The unsent one is gone.
    expect([...storage.objects.keys()]).toEqual([
      expect.stringContaining(uploadId),
    ]);
    expect([...storage.objects.keys()][0]).not.toContain(unsent);
  });
});
