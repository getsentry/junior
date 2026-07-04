import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "chat";
import {
  createTestMessage,
  createTestThread,
  createTestDestination,
} from "../../fixtures/slack-harness";
import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { flattenAgentRunRequestForTest } from "../../fixtures/agent-runner";

const ORIGINAL_ENV = { ...process.env };

async function createRuntime(
  args: Parameters<
    typeof import("../../fixtures/chat-runtime").createTestChatRuntime
  >[0],
  env: NodeJS.ProcessEnv = {},
) {
  process.env = {
    ...ORIGINAL_ENV,
    AI_VISION_MODEL: "",
    SLACK_BOT_TOKEN: "",
    SLACK_BOT_USER_TOKEN: "",
    ...env,
  };
  vi.resetModules();
  const { createTestChatRuntime } = await import("../../fixtures/chat-runtime");
  return createTestChatRuntime(args);
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

describe("Slack behavior: mixed attachment media", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  it("keeps valid attachments while skipping oversized and failed fetch attachments", async () => {
    const imageFetch = vi.fn(async () => Buffer.from("image-bytes"));
    const oversizedFetch = vi.fn(async () => Buffer.alloc(5 * 1024 * 1024 + 1));
    const failingFetch = vi.fn(async () => {
      throw new Error("download failed");
    });
    const completeTextMock = vi.fn(async () => ({
      text: "Chart screenshot with an upward trend.",
      message: {} as never,
    }));

    const capturedAttachmentMediaTypes: string[][] = [];
    const capturedAttachmentNames: string[][] = [];

    const { slackRuntime } = await createRuntime(
      {
        services: {
          visionContext: {
            completeText: completeTextMock,
          },
          replyExecutor: {
            agentRunner: {
              run: async (request) => {
                const _prompt = request.input.messageText;
                const context = {
                  ...flattenAgentRunRequestForTest(request),
                };

                const attachments = context?.userAttachments ?? [];
                capturedAttachmentMediaTypes.push(
                  attachments.map((attachment) => attachment.mediaType),
                );
                capturedAttachmentNames.push(
                  attachments.map((attachment) => attachment.filename ?? ""),
                );
                return completedAgentRun({
                  text: "Processed attachments.",
                  diagnostics: {
                    assistantMessageCount: 1,
                    modelId: "fake-agent-model",
                    outcome: "success" as const,
                    toolCalls: [],
                    toolErrorCount: 0,
                    toolResultCount: 0,
                    usedPrimaryText: true,
                  },
                });
              },
            },
          },
        },
      },
      {
        AI_VISION_MODEL: "openai/gpt-5.4",
      },
    );

    const thread = createTestThread({
      id: "slack:C_BEHAVIOR:1700004010.000",
    });
    const message = createTestMessage({
      id: "m-attachment-mixed-1",
      text: "<@U_APP> summarize these files",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
      attachments: [
        {
          type: "image",
          mimeType: "image/png",
          name: "chart.png",
          url: "https://files.slack.com/private/chart.png",
          fetchData: imageFetch,
        },
        {
          type: "file",
          mimeType: "application/pdf",
          name: "incident.pdf",
          data: Buffer.from("pdf-bytes"),
        },
        {
          type: "file",
          mimeType: "application/zip",
          name: "large.zip",
          url: "https://files.slack.com/private/large.zip",
          fetchData: oversizedFetch,
        },
        {
          type: "file",
          mimeType: "application/json",
          name: "broken.json",
          url: "https://files.slack.com/private/broken.json",
          fetchData: failingFetch,
        },
      ] as Message["attachments"],
    });

    await slackRuntime.handleNewMention(thread, message, {
      destination: createTestDestination(thread),
    });

    expect(imageFetch).toHaveBeenCalledTimes(1);
    expect(completeTextMock).toHaveBeenCalledTimes(1);
    expect(oversizedFetch).toHaveBeenCalledTimes(1);
    expect(failingFetch).toHaveBeenCalledTimes(1);

    expect(capturedAttachmentMediaTypes).toEqual([
      ["image/png", "application/pdf"],
    ]);
    expect(capturedAttachmentNames).toEqual([["chart.png", "incident.pdf"]]);
  }, 20_000);

  it("drops image attachments when AI_VISION_MODEL is unset", async () => {
    const imageFetch = vi.fn(async () => Buffer.from("image-bytes"));

    const capturedAttachmentMediaTypes: string[][] = [];
    const capturedAttachmentNames: string[][] = [];
    const capturedOmittedImageCounts: number[] = [];

    const { slackRuntime } = await createRuntime({
      services: {
        replyExecutor: {
          agentRunner: {
            run: async (request) => {
              const _prompt = request.input.messageText;
              const context = {
                ...flattenAgentRunRequestForTest(request),
              };

              const attachments = context?.userAttachments ?? [];
              capturedAttachmentMediaTypes.push(
                attachments.map((attachment) => attachment.mediaType),
              );
              capturedAttachmentNames.push(
                attachments.map((attachment) => attachment.filename ?? ""),
              );
              capturedOmittedImageCounts.push(
                context?.omittedImageAttachmentCount ?? 0,
              );
              return completedAgentRun({
                text: "Processed attachments.",
                diagnostics: {
                  assistantMessageCount: 1,
                  modelId: "fake-agent-model",
                  outcome: "success" as const,
                  toolCalls: [],
                  toolErrorCount: 0,
                  toolResultCount: 0,
                  usedPrimaryText: true,
                },
              });
            },
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700004011.000" });
    const message = createTestMessage({
      id: "m-attachment-mixed-2",
      text: "<@U_APP> summarize these files",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
      attachments: [
        {
          type: "image",
          mimeType: "image/png",
          name: "chart.png",
          url: "https://files.slack.com/private/chart.png",
          fetchData: imageFetch,
        },
        {
          type: "file",
          mimeType: "application/pdf",
          name: "incident.pdf",
          data: Buffer.from("pdf-bytes"),
        },
      ] as Message["attachments"],
    });

    await slackRuntime.handleNewMention(thread, message, {
      destination: createTestDestination(thread),
    });

    expect(imageFetch).not.toHaveBeenCalled();
    expect(capturedAttachmentMediaTypes).toEqual([["application/pdf"]]);
    expect(capturedAttachmentNames).toEqual([["incident.pdf"]]);
    expect(capturedOmittedImageCounts).toEqual([1]);
  });

  it("still runs the assistant when only images are attached and vision is disabled", async () => {
    const imageFetch = vi.fn(async () => Buffer.from("image-bytes"));
    const capturedOmittedImageCounts: number[] = [];
    const executeAgentRun = vi.fn<AgentRunner["run"]>(async (_request) => {
      return completedAgentRun({
        text: "I can’t inspect the attached image in this runtime, but I do see that an image was included.",
        diagnostics: {
          assistantMessageCount: 1,
          modelId: "fake-agent-model",
          outcome: "success" as const,
          toolCalls: [],
          toolErrorCount: 0,
          toolResultCount: 0,
          usedPrimaryText: true,
        },
      });
    });

    const { slackRuntime } = await createRuntime({
      services: {
        replyExecutor: {
          agentRunner: {
            run: async (request) => {
              const context = {
                ...flattenAgentRunRequestForTest(request),
              };

              capturedOmittedImageCounts.push(
                context?.omittedImageAttachmentCount ?? 0,
              );
              return executeAgentRun(request);
            },
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700004012.000" });
    const message = createTestMessage({
      id: "m-attachment-mixed-3",
      text: "<@U_APP> what about this image?",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
      attachments: [
        {
          type: "image",
          mimeType: "image/png",
          name: "chart.png",
          url: "https://files.slack.com/private/chart.png",
          fetchData: imageFetch,
        },
      ] as Message["attachments"],
    });

    await slackRuntime.handleNewMention(thread, message, {
      destination: createTestDestination(thread),
    });

    expect(imageFetch).not.toHaveBeenCalled();
    expect(executeAgentRun).toHaveBeenCalledTimes(1);
    expect(capturedOmittedImageCounts).toEqual([1]);
    expect(thread.posts).toHaveLength(1);
    expect(toPostedText(thread.posts[0])).toContain(
      "I can’t inspect the attached image",
    );
  });
});
