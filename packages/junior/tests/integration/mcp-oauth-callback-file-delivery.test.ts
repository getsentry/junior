import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { successfulAssistantReply } from "../fixtures/assistant-reply";
import {
  EVAL_MCP_AUTH_CODE,
  EVAL_MCP_AUTH_PROVIDER,
  createMcpOauthCallbackSlackFixture,
} from "../fixtures/mcp-oauth-callback-slack";
import {
  getCapturedSlackApiCalls,
  getCapturedSlackFileUploadCalls,
} from "../msw/handlers/slack-api";

let testbed: Awaited<ReturnType<typeof createMcpOauthCallbackSlackFixture>>;

describe("mcp oauth callback resumed file delivery", () => {
  beforeEach(async () => {
    testbed = await createMcpOauthCallbackSlackFixture();
  });

  afterEach(async () => {
    await testbed.cleanup();
  });

  it("uploads resumed reply files without posting an extra thread message for empty inline text", async () => {
    testbed.generateAssistantReplyMock.mockResolvedValueOnce(
      successfulAssistantReply("", {
        files: [
          {
            data: Buffer.from("hello"),
            filename: "resume.txt",
          },
        ],
        deliveryPlan: {
          mode: "thread",
          postThreadText: true,
          attachFiles: "inline",
        },
      }),
    );
    await testbed.storePendingMcpThreadState({
      threadId: "slack:C123:1700000000.002",
      messageId: "msg.2",
      text: "/demo upload",
      sessionId: "turn_msg_2",
    });
    await testbed.createAwaitingMcpTurnRecord({
      conversationId: "conversation-2",
      sessionId: "turn_msg_2",
      text: "/demo upload",
    });

    const authProvider = await testbed.createPendingAuthSession({
      conversationId: "conversation-2",
      sessionId: "turn_msg_2",
      userMessage: "/demo upload",
      channelId: "C123",
      threadTs: "1700000000.002",
    });

    const response = await testbed.runRoute({
      provider: EVAL_MCP_AUTH_PROVIDER,
      state: authProvider.authSessionId,
      code: EVAL_MCP_AUTH_CODE,
    });

    expect(response.status).toBe(200);
    expect(getCapturedSlackApiCalls("chat.postMessage")).toHaveLength(0);
    expect(getCapturedSlackApiCalls("files.getUploadURLExternal")).toHaveLength(
      1,
    );
    expect(getCapturedSlackApiCalls("files.completeUploadExternal")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel_id: "C123",
          thread_ts: "1700000000.002",
        }),
      }),
    ]);
    expect(getCapturedSlackFileUploadCalls()).toHaveLength(1);
  });

  it("uploads resumed reply files even when thread text delivery is suppressed", async () => {
    testbed.generateAssistantReplyMock.mockResolvedValueOnce(
      successfulAssistantReply("ok", {
        files: [
          {
            data: Buffer.from("hello"),
            filename: "resume.txt",
          },
        ],
        deliveryPlan: {
          mode: "thread",
          postThreadText: false,
          attachFiles: "inline",
        },
      }),
    );
    await testbed.storePendingMcpThreadState({
      threadId: "slack:C123:1700000000.003",
      messageId: "msg.3",
      text: "/demo upload",
      sessionId: "turn_msg_3",
    });
    await testbed.createAwaitingMcpTurnRecord({
      conversationId: "conversation-3",
      sessionId: "turn_msg_3",
      text: "/demo upload",
    });

    const authProvider = await testbed.createPendingAuthSession({
      conversationId: "conversation-3",
      sessionId: "turn_msg_3",
      userMessage: "/demo upload",
      channelId: "C123",
      threadTs: "1700000000.003",
    });

    const response = await testbed.runRoute({
      provider: EVAL_MCP_AUTH_PROVIDER,
      state: authProvider.authSessionId,
      code: EVAL_MCP_AUTH_CODE,
    });

    expect(response.status).toBe(200);
    expect(getCapturedSlackApiCalls("chat.postMessage")).toHaveLength(0);
    expect(getCapturedSlackApiCalls("files.getUploadURLExternal")).toHaveLength(
      1,
    );
    expect(getCapturedSlackApiCalls("files.completeUploadExternal")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel_id: "C123",
          thread_ts: "1700000000.003",
        }),
      }),
    ]);
    expect(getCapturedSlackFileUploadCalls()).toHaveLength(1);
  });
});
