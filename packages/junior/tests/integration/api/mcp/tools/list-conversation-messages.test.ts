import { http, HttpResponse } from "msw";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createApp } from "@/app";
import { getConversationEventStore, getDb } from "@/chat/db";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { juniorIdentities } from "@/db/schema";
import {
  callMcpTool,
  connectMcpClient,
  connectMcpTools,
  MCP_TEST_ALLOWED_DOMAINS,
  MCP_TEST_ORIGIN,
  MCP_TEST_OTHER_VIEWER,
  MCP_TEST_VIEWER,
  mockMcpDashboardConfig,
} from "../../../../fixtures/mcp-http";
import { mswServer } from "../../../../msw/server";
import {
  appendMcpMessages,
  seedMcpConversation,
} from "../../../../fixtures/mcp-tools";

mockMcpDashboardConfig();

const CONVERSATION_ID = "slack:C123:1700000000.000300";
const OTHER_CONVERSATION_ID = "slack:C123:1700000000.000400";

describe("listConversationMessages MCP tool", () => {
  it("pages back from the newest message with a cursor", async () => {
    await seedMcpConversation({
      conversationId: CONVERSATION_ID,
      email: MCP_TEST_VIEWER,
      title: "Viewer incident",
    });
    await appendMcpMessages(CONVERSATION_ID, [
      { role: "user", text: "What broke?" },
      { role: "assistant", text: "The relay deploy broke ingestion." },
      { role: "user", text: "Roll it back." },
      { role: "assistant", text: "The rollback is done." },
    ]);
    const call = await connectMcpTools();

    const newest = await call("listConversationMessages", {
      conversationId: CONVERSATION_ID,
      limit: 3,
    });
    const older = await call("listConversationMessages", {
      before: (newest.structuredContent as { nextCursor: string }).nextCursor,
      conversationId: CONVERSATION_ID,
    });

    expect(newest.structuredContent).toEqual({
      messages: [
        expect.objectContaining({ text: "The relay deploy broke ingestion." }),
        expect.objectContaining({ text: "Roll it back." }),
        expect.objectContaining({ text: "The rollback is done." }),
      ],
      nextCursor: expect.any(String),
    });
    expect(older.structuredContent).toEqual({
      messages: [
        expect.objectContaining({ role: "user", text: "What broke?" }),
      ],
    });
  });

  it("names each author and serves their photo to the MCP token", async () => {
    mswServer.use(
      http.get(
        "https://avatars.slack-edge.com/viewer.png",
        async () =>
          new HttpResponse(
            await sharp({
              create: {
                width: 64,
                height: 64,
                channels: 3,
                background: "#7553ff",
              },
            })
              .png()
              .toBuffer(),
          ),
      ),
    );
    await seedMcpConversation({
      conversationId: CONVERSATION_ID,
      email: MCP_TEST_VIEWER,
      title: "Viewer incident",
    });
    const viewer = await resolveViewerUser(MCP_TEST_VIEWER);
    await getDb()
      .insert(juniorIdentities)
      .values({
        avatarUrl: "https://avatars.slack-edge.com/viewer.png",
        createdAt: new Date(1_000),
        displayName: "Viewer Person",
        id: "slack-viewer",
        kind: "user",
        provider: "slack",
        providerSubjectId: "UVIEWER",
        providerTenantId: "T123",
        updatedAt: new Date(1_000),
        userId: viewer!.id,
      });
    await getConversationEventStore().append(CONVERSATION_ID, [
      {
        createdAtMs: Date.now(),
        data: {
          authorIdentityId: "slack-viewer",
          messageId: "viewer-1",
          role: "user",
          text: "What broke?",
          type: "message",
        },
      },
    ]);
    const app = await createApp({ allowedDomains: MCP_TEST_ALLOWED_DOMAINS });
    const token = await connectMcpClient(app, MCP_TEST_VIEWER);

    const result = await callMcpTool(app, token, "listConversationMessages", {
      conversationId: CONVERSATION_ID,
    });
    const [message] = (
      result.structuredContent as {
        messages: { author?: string; authorAvatarUrl?: string }[];
      }
    ).messages;
    const photoUrl = `${MCP_TEST_ORIGIN}${message!.authorAvatarUrl}`;
    const photo = await app.request(photoUrl, {
      headers: { authorization: `Bearer ${token}` },
    });
    const signedOut = await app.request(photoUrl);

    expect(message).toMatchObject({
      author: "Viewer Person",
      authorAvatarUrl: expect.stringMatching(
        /^\/api\/mcp\/avatars\/slack-viewer\?v=[0-9a-f]{16}$/,
      ),
    });
    expect(photo.status).toBe(200);
    expect(photo.headers.get("content-type")).toBe("image/webp");
    expect(signedOut.status).toBe(401);
  });

  it("rejects a cursor from another Conversation and hides other Conversations", async () => {
    await seedMcpConversation({
      conversationId: CONVERSATION_ID,
      email: MCP_TEST_VIEWER,
      title: "Viewer incident",
    });
    await seedMcpConversation({
      conversationId: OTHER_CONVERSATION_ID,
      email: MCP_TEST_OTHER_VIEWER,
      title: "Other incident",
    });
    await appendMcpMessages(CONVERSATION_ID, [
      { role: "user", text: "First." },
      { role: "assistant", text: "Second." },
    ]);
    await seedMcpConversation({
      conversationId: "slack:C123:1700000000.000500",
      email: MCP_TEST_VIEWER,
      title: "Second viewer incident",
    });
    await appendMcpMessages("slack:C123:1700000000.000500", [
      { role: "user", text: "Third." },
      { role: "assistant", text: "Fourth." },
    ]);
    const call = await connectMcpTools();
    const page = await call("listConversationMessages", {
      conversationId: "slack:C123:1700000000.000500",
      limit: 1,
    });

    const wrongCursor = await call("listConversationMessages", {
      before: (page.structuredContent as { nextCursor: string }).nextCursor,
      conversationId: CONVERSATION_ID,
    });
    const hidden = await call("listConversationMessages", {
      conversationId: OTHER_CONVERSATION_ID,
    });

    expect(wrongCursor).toMatchObject({
      isError: true,
      content: [
        {
          type: "text",
          text: "The cursor is not valid. Omit `before` to read the newest messages.",
        },
      ],
    });
    expect(hidden).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Conversation not found." }],
    });
  });
});
