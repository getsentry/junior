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
import {
  createModelAgentRunner,
  createModelAgentRunnerForRun,
} from "../../fixtures/agent-runner";
import { createModelStream } from "../../fixtures/model-stream";

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
