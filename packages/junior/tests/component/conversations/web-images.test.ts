import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createConversationRoutes } from "@/api/conversations/routes";
import type { JuniorApiEnv } from "@/api/route";
import {
  createAndEnqueueConversation,
  appendAndEnqueueWebMessage,
} from "@/chat/conversations/web-input";
import { decodeInputImages } from "@/chat/attachments/images";
import { createConversationBodySchema } from "@/api/schema";
import {
  createConversationFixture,
  closeConversationFixture,
} from "../../fixtures/conversation";
import { memoryAttachmentStorage } from "../../fixtures/attachment-storage";
import { testViewer } from "../../fixtures/user";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU1sAAAAASUVORK5CYII=";

describe("web image input", () => {
  afterEach(closeConversationFixture);

  it("stores image-only input once and shows it only to participants", async () => {
    const fixture = await createConversationFixture();
    const storage = memoryAttachmentStorage();
    const body = createConversationBodySchema.parse({
      message: "",
      idempotencyKey: "image-create",
      visibility: "private",
      images: [{ filename: "pixel.png", contentType: "image/png", data: png }],
    });
    const input = {
      ...body,
      actor: fixture.actor,
      images: decodeInputImages(body.images ?? []),
    };
    const options = { ...fixture, attachmentStorage: storage };
    const accepted = await createAndEnqueueConversation(input, options);
    expect(await createAndEnqueueConversation(input, options)).toEqual({
      ...accepted,
      status: "duplicate",
    });
    expect(storage.objects.size).toBe(1);

    const app = new Hono<JuniorApiEnv>();
    app.use("*", async (context, next) => {
      const email = context.req.header("x-test-viewer");
      if (email) context.set("viewer", testViewer(email));
      await next();
    });
    app.route(
      "/api/conversations",
      createConversationRoutes({
        attachmentStorage: storage,
        queue: fixture.queue,
      }),
    );
    const base = `/api/conversations/${encodeURIComponent(accepted.conversationId)}`;
    const headers = { "x-test-viewer": fixture.actor.email };
    const pending = await (
      await app.request(`${base}/pending-messages`, { headers })
    ).json();
    expect(pending.messages).toHaveLength(1);
    const attachment = pending.messages[0].attachments[0];
    expect(attachment).toEqual({
      id: expect.any(String),
      filename: "pixel.png",
      contentType: "image/png",
      bytes: Buffer.from(png, "base64").length,
    });
    expect(JSON.stringify(pending)).not.toContain(png);
    expect(pending.messages[0].text).toBe("");
    const outsider = await (
      await app.request(`${base}/pending-messages`, {
        headers: { "x-test-viewer": "other@example.com" },
      })
    ).json();
    expect(outsider.messages[0]).toMatchObject({ redacted: true });
    expect(outsider.messages[0].attachments).toBeUndefined();
    await appendAndEnqueueWebMessage(
      {
        actor: fixture.actor,
        conversationId: accepted.conversationId,
        message: "Another look",
        idempotencyKey: "image-followup",
        images: input.images,
      },
      options,
    );
    const continued = await (
      await app.request(`${base}/pending-messages`, { headers })
    ).json();
    expect(continued.messages).toHaveLength(2);
    expect(continued.messages[1]).toMatchObject({
      text: "Another look",
      attachments: [attachment],
    });
  });
  it("does not enqueue an image when storage fails", async () => {
    const fixture = await createConversationFixture();
    const storage = memoryAttachmentStorage();
    storage.put = async () => {
      throw new Error("Storage unavailable");
    };
    const input = {
      actor: fixture.actor,
      idempotencyKey: "failed-image",
      message: "Look at this",
      images: decodeInputImages([
        { filename: "pixel.png", contentType: "image/png", data: png },
      ]),
    };
    await expect(
      createAndEnqueueConversation(input, {
        ...fixture,
        attachmentStorage: storage,
      }),
    ).rejects.toThrow("Storage unavailable");
    expect(fixture.queue.queuedMessages()).toHaveLength(0);
  });
});
