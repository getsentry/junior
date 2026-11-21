import {
  createSlackSource,
  defineJuniorPlugin,
  type ToolRegistrationHookContext,
} from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, defineJuniorPlugins } from "@/app";
import { createMemoryAttachmentStorage } from "@/chat/attachments/memory";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import { turnBehavior } from "@/chat/conversations/kind-behavior";
import { closeDb } from "@/chat/db";
import { getPluginTools } from "@/chat/plugins/agent-hooks";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import {
  CONVERSATION_ID,
  SLACK_DESTINATION,
} from "../../fixtures/conversation-work";

async function pluginDownloadUrls(attachmentStorage: AttachmentStorage) {
  let downloadUrls: ToolRegistrationHookContext["downloadUrls"];
  await createApp({
    plugins: defineJuniorPlugins([
      defineJuniorPlugin({
        manifest: { name: "demo", displayName: "Demo", description: "Demo" },
        hooks: {
          tools() {
            return {};
          },
          disabledTools(ctx) {
            downloadUrls = ctx.downloadUrls;
            return {};
          },
        },
      }),
    ]),
  });
  getPluginTools({
    attachmentStorage,
    conversationId: CONVERSATION_ID,
    destination: SLACK_DESTINATION,
    egress: { fetch: async () => new Response("ok") },
    source: createSlackSource({
      teamId: "T123",
      channelId: "C123",
      visibility: "public",
    }),
    turnTools: turnBehavior({ kind: "root", personInput: true }).tools,
    workspace: {} as never,
  });
  return downloadUrls;
}

describe("plugin download URLs", () => {
  afterEach(async () => {
    await closeDb();
    await disconnectStateAdapter();
  });

  it("signs a private copy for at most five minutes and deletes it on request", async () => {
    const signed: Array<{ expiresAtMs: number; key: string }> = [];
    const storage = {
      ...createMemoryAttachmentStorage(),
      async createDownloadUrl(input: { expiresAtMs: number; key: string }) {
        signed.push(input);
        return `https://storage.example/${input.key}?sig=1`;
      },
    };
    const downloadUrls = await pluginDownloadUrls(storage);

    const before = Date.now();
    const link = await downloadUrls!.create({
      body: new Uint8Array([1, 2, 3]),
      contentType: "image/png",
    });

    const [request] = signed;
    expect(link.url).toBe(`https://storage.example/${request!.key}?sig=1`);
    expect(request!.key).toMatch(
      new RegExp(`^conversations/${CONVERSATION_ID}/downloads/`),
    );
    expect(request!.expiresAtMs - before).toBeLessThanOrEqual(
      5 * 60 * 1000 + 50,
    );
    expect(storage.objects.get(request!.key)).toEqual(Buffer.from([1, 2, 3]));

    await link.delete();
    expect(storage.objects.has(request!.key)).toBe(false);
  });

  it("deletes the copy and rethrows when signing fails", async () => {
    const storage = {
      ...createMemoryAttachmentStorage(),
      async createDownloadUrl(): Promise<string> {
        throw new Error("presign failed");
      },
    };
    const downloadUrls = await pluginDownloadUrls(storage);

    await expect(
      downloadUrls!.create({
        body: new Uint8Array([1, 2, 3]),
        contentType: "image/png",
      }),
    ).rejects.toThrow("presign failed");
    expect(storage.objects.size).toBe(0);
  });

  it("is absent when the storage cannot sign reads", async () => {
    await expect(
      pluginDownloadUrls(createMemoryAttachmentStorage()),
    ).resolves.toBeUndefined();
  });
});
