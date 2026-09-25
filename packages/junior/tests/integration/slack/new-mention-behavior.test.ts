import type { Message } from "chat";
import { describe, expect, it } from "vitest";
import {
  FakeSlackAdapter,
  createTestDestination,
} from "../../fixtures/slack-harness";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import {
  createTestMessage,
  createTestThread,
} from "../../fixtures/slack-harness";
import { hydrateConversationMessages } from "@/chat/conversations/messages";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import {
  createModelAgentRunner,
  createModelAgentRunnerForRun,
} from "../../fixtures/agent-runner";
import { createModelStream } from "../../fixtures/model-stream";

interface CapturedRun {
  prompt: string;
  piMessages?: unknown[];
}

function toPostedText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object") {
    const markdown = (value as { markdown?: unknown }).markdown;
    if (typeof markdown === "string") {
      return markdown;
    }
  }

  return String(value);
}

describe("Slack behavior: new mention", () => {
  it("includes queued SDK messages in the assistant prompt", async () => {
    const agentRuns: CapturedRun[] = [];

    const { slackRuntime } = createTestChatRuntime({
      services: {
        agentRunner: createModelAgentRunnerForRun((request) => {
          agentRuns.push({
            prompt: request.instruction.text,
            piMessages: request.history ? [...request.history] : undefined,
          });
          return createModelStream([
            { type: "text", text: "Handled both updates." },
          ]);
        }),
      },
    });

    const thread = await createTestThread({
      id: "slack:C0QUEUED:1700001234.000",
    });
    const queued = createTestMessage({
      id: "m-queued",
      text: "<@U0APP> first queued request",
      isMention: true,
      threadId: thread.id,
      dateSent: new Date(1700001234000),
    });
    const latest = createTestMessage({
      id: "m-latest",
      text: "<@U0APP> latest request",
      isMention: true,
      threadId: thread.id,
      dateSent: new Date(1700001235000),
    });

    await slackRuntime.handleNewMention(thread, latest, {
      destination: createTestDestination(thread),
      messageContext: {
        skipped: [queued],
        totalSinceLastHandler: 2,
      },
    });

    expect(agentRuns).toHaveLength(1);
    expect(agentRuns[0]?.prompt).toContain("latest request");
    expect(agentRuns[0]?.prompt).not.toContain("first queued request");
    expect(JSON.stringify(agentRuns[0]?.piMessages)).toContain(
      "first queued request",
    );
    const conversation = coerceThreadConversationState(await thread.getState());
    await hydrateConversationMessages({
      conversation,
      conversationId: thread.id,
    });
    expect(
      conversation.messages
        .filter(
          (message) => message.id === "m-queued" || message.id === "m-latest",
        )
        .map((message) => ({ id: message.id, text: message.text })),
    ).toEqual([
      { id: "m-queued", text: "first queued request" },
      { id: "m-latest", text: "latest request" },
    ]);
    expect(thread.posts).toHaveLength(1);
    expect(toPostedText(thread.posts[0])).toContain("Handled both updates.");
  });

  it("forwards queued SDK message attachments to the assistant context", async () => {
    const agentRuns: Array<{
      attachmentText?: string;
      filenames: string[];
      inboundAttachmentCount?: number;
      piMessages?: unknown[];
      prompt: string;
    }> = [];

    const { slackRuntime } = createTestChatRuntime({
      services: {
        agentRunner: createModelAgentRunnerForRun((request) => {
          const attachments = request.instruction.attachments ?? [];
          agentRuns.push({
            prompt: request.instruction.text,
            inboundAttachmentCount: request.instruction.inboundAttachmentCount,
            filenames: attachments.map(
              (attachment) => attachment.filename ?? "",
            ),
            attachmentText: attachments[0]?.data?.toString("utf8"),
            piMessages: request.history ? [...request.history] : undefined,
          });
          return createModelStream([
            { type: "text", text: "Handled queued attachment." },
          ]);
        }),
      },
    });

    const thread = await createTestThread({
      id: "slack:C0QUEUEDATTACHMENTS:1700001234.000",
    });
    const queued = createTestMessage({
      id: "m-queued-file",
      text: "<@U0APP> review this file first",
      isMention: true,
      threadId: thread.id,
      attachments: [
        {
          type: "file",
          mimeType: "text/plain",
          name: "queued-notes.txt",
          data: Buffer.from("queued attachment notes"),
        },
      ] as Message["attachments"],
    });
    const latest = createTestMessage({
      id: "m-latest-file",
      text: "<@U0APP> then answer now",
      isMention: true,
      threadId: thread.id,
    });

    await slackRuntime.handleNewMention(thread, latest, {
      destination: createTestDestination(thread),
      messageContext: {
        skipped: [queued],
        totalSinceLastHandler: 2,
      },
    });

    expect(agentRuns).toEqual([
      expect.objectContaining({
        prompt: "then answer now",
        inboundAttachmentCount: 1,
        filenames: ["queued-notes.txt"],
        attachmentText: "queued attachment notes",
      }),
    ]);
    expect(JSON.stringify(agentRuns[0]?.piMessages)).toContain(
      "review this file first",
    );
    expect(thread.posts).toHaveLength(1);
    expect(toPostedText(thread.posts[0])).toContain(
      "Handled queued attachment.",
    );
  });

  it("clears assistant status after agent error", async () => {
    const slackAdapter = new FakeSlackAdapter();
    const { slackRuntime } = createTestChatRuntime({
      slackAdapter,
      services: {
        agentRunner: createModelAgentRunner(
          createModelStream([
            { type: "error", errorMessage: "model exploded" },
          ]),
        ),
      },
    });

    const thread = await createTestThread({
      id: "slack:C0STATUS:1700003000.000",
    });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-status-error",
        text: "<@U0APP> do something",
        isMention: true,
        threadId: thread.id,
      }),
      { destination: createTestDestination(thread) },
    );

    expect(slackAdapter.statusCalls.length).toBeGreaterThan(0);
    expect(slackAdapter.statusCalls.at(-1)).toEqual({
      channelId: "C0STATUS",
      threadTs: "1700003000.000",
      text: "",
      loadingMessages: undefined,
    });
  });
});
