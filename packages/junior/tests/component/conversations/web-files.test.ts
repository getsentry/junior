import { afterEach, describe, expect, it } from "vitest";
import { createWebSource } from "@sentry/junior-plugin-api";
import { Hono } from "hono";
import { createConversationRoutes } from "@/api/conversations/routes";
import type { JuniorApiEnv } from "@/api/route";
import { getConversationEventStore } from "@/chat/db";
import { createTools } from "@/chat/tools";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { memoryAttachmentStorage } from "../../fixtures/attachment-storage";
import {
  createConversationFixture,
  closeConversationFixture,
} from "../../fixtures/conversation";
import { getCapturedSlackApiCalls } from "../../msw/handlers/slack-api";
import { testViewer } from "../../fixtures/user";

async function webFiles() {
  const fixture = await createConversationFixture();
  const conversationId = "local:web:send-files";
  const destination = { platform: "local" as const, conversationId };
  await fixture.conversationStore.recordActivity({
    conversationId,
    actor: { email: fixture.actor.email, fullName: fixture.actor.fullName },
    destination,
    source: "web",
    visibility: "private",
    title: "Web file delivery",
    nowMs: Date.now(),
  });
  const files = new Map([
    ["/tmp/desktop.png", Buffer.from("desktop image")],
    ["/tmp/mobile.png", Buffer.from("mobile image")],
  ]);
  const storage = memoryAttachmentStorage();
  const context: ToolRuntimeContext = {
    conversationId,
    conversationPrivacy: "private",
    destination,
    source: createWebSource(conversationId, "private"),
    actor: fixture.actor,
    attachmentStorage: storage,
    egress: { fetch: ({ request }) => fetch(request) },
    workspace: {
      readFileToBuffer: async ({ path }) => files.get(path) ?? null,
      runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      writeFiles: async () => undefined,
    },
  };
  return { ...fixture, context, storage, conversationId };
}

describe("web file delivery", () => {
  afterEach(closeConversationFixture);

  it("attaches sandbox files to a web Conversation without Slack or public publishing", async () => {
    const fixture = await webFiles();
    const { context, conversationId, storage } = fixture;
    expect(
      createTools([], {}, { ...context, attachmentStorage: undefined }),
    ).not.toHaveProperty("sendFiles");
    const tool = createTools([], {}, context).sendFiles;
    if (!tool?.execute) throw new Error("sendFiles is unavailable");
    const input = {
      files: [{ path: "/tmp/desktop.png" }, { path: "/tmp/mobile.png" }],
    };
    await tool.execute(input, { toolCallId: "send-screenshots" });
    expect(storage.objects.size).toBe(2);
    expect(getCapturedSlackApiCalls("files.completeUploadExternal")).toEqual(
      [],
    );

    const app = new Hono<JuniorApiEnv>();
    app.use("*", async (ctx, next) => {
      const email = ctx.req.header("x-test-viewer");
      if (email) ctx.set("viewer", testViewer(email));
      await next();
    });
    app.route(
      "/api/conversations",
      createConversationRoutes({ attachmentStorage: storage }),
    );
    const base = `/api/conversations/${encodeURIComponent(conversationId)}`;
    const headers = { "x-test-viewer": fixture.actor.email };
    const report = await (await app.request(base, { headers })).json();
    const delivered = report.events.filter(
      (event: { data: { type: string } }) =>
        event.data.type === "attachments_delivered",
    );
    expect(delivered).toHaveLength(1);
    expect(delivered[0].data).toMatchObject({
      attachments: [
        {
          id: expect.any(String),
          filename: "desktop.png",
          contentType: "image/png",
          bytes: 13,
        },
        {
          id: expect.any(String),
          filename: "mobile.png",
          contentType: "image/png",
          bytes: 12,
        },
      ],
    });
    const path = `${base}/attachments/${delivered[0].data.attachments[0].id}`;
    const download = await app.request(path, { headers });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("image/png");
    expect(download.headers.get("cache-control")).toBe("private, no-store");
    expect(await download.text()).toBe("desktop image");
    expect((await app.request(path)).status).toBe(404);
    expect(
      (
        await app.request(path, {
          headers: { "x-test-viewer": "other@example.com" },
        })
      ).status,
    ).toBe(404);
  });

  it("does not report delivery when storage fails and can retry the same files", async () => {
    const { context, conversationId, storage } = await webFiles();
    const tool = createTools([], {}, context).sendFiles;
    if (!tool?.execute) throw new Error("sendFiles is unavailable");
    const put = storage.put;
    storage.put = async () => {
      throw new Error("Storage unavailable");
    };
    const input = { files: [{ path: "/tmp/desktop.png" }] };
    await expect(
      tool.execute(input, { toolCallId: "send-failed" }),
    ).rejects.toThrow("Storage unavailable");
    const history =
      await getConversationEventStore().loadHistory(conversationId);
    expect(
      history.filter((event) => event.data.type === "attachments_delivered"),
    ).toEqual([]);
    storage.put = put;
    await expect(
      tool.execute(input, { toolCallId: "send-retry" }),
    ).resolves.toMatchObject({
      attachment_refs: [{ id: expect.any(String), filename: "desktop.png" }],
    });
  });
});
