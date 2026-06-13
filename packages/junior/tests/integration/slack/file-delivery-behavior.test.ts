import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import type { Thread } from "chat";
import { successfulAssistantReply } from "../../fixtures/assistant-reply";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import { postedText } from "../../fixtures/slack/behavior";
import {
  createTestMessage,
  createTestThread,
  createTestDestination,
} from "../../fixtures/slack/harness";

function findFilePost(calls: unknown[][]): unknown[] | undefined {
  return calls.find(
    (call) =>
      typeof call[0] === "object" &&
      call[0] !== null &&
      "files" in (call[0] as Record<string, unknown>) &&
      Array.isArray((call[0] as { files?: unknown[] }).files) &&
      (call[0] as { files: unknown[] }).files.length > 0,
  );
}

describe("Slack behavior: file delivery", () => {
  it("ignores file followup plans when the assistant reply has no files", async () => {
    const { slackRuntime } = createTestChatRuntime({
      adapters: {
        generateAssistantReply: async (_prompt, context) => {
          await context?.onTextDelta?.("Preview is ready.");
          return successfulAssistantReply("Preview is ready.", {
            deliveryPlan: {
              mode: "thread",
              postThreadText: true,
              attachFiles: "followup",
            },
          });
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_FILES:1700004020.000" });
    const message = createTestMessage({
      id: "m-file-plan-1",
      text: "<@U_APP> show me the preview",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
    });

    await slackRuntime.handleNewMention(thread, message, {
      destination: createTestDestination(thread),
    });

    expect(thread.posts.map(postedText)).toEqual(["Preview is ready."]);
  });

  it("attaches generated files inline on the finalized reply post", async () => {
    const { slackRuntime } = createTestChatRuntime({
      adapters: {
        generateAssistantReply: async () => {
          return successfulAssistantReply("finalized content", {
            files: [
              {
                data: Buffer.from("fake-png"),
                filename: "generated.png",
                mimeType: "image/png",
              },
            ],
          });
        },
      },
    });

    const postSpy = vi.fn().mockResolvedValue(undefined);
    const thread = createTestThread({
      id: "slack:C_STREAM:1700000000.000",
      state: {},
    });
    thread.post = postSpy as unknown as Thread["post"];

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "1700000000.200",
        text: "generate an image",
        threadId: "slack:C_STREAM:1700000000.000",
        isMention: true,
        author: {
          userId: "U-user",
          userName: "user",
          fullName: "User Example",
          isBot: false,
          isMe: false,
        },
      }),
    );

    expect(postSpy.mock.calls).toHaveLength(1);

    const filePost = findFilePost(postSpy.mock.calls);
    expect(filePost).toBeDefined();
    const filePostArg = filePost![0] as Record<string, unknown>;
    expect(filePostArg).toHaveProperty("markdown", "finalized content");
    expect((filePostArg.files as Array<{ filename: string }>)[0].filename).toBe(
      "generated.png",
    );
  });
});
