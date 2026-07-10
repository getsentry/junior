import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const {
  executeAgentRunMock,
  handleSubscribedMessageMock,
  observedRuntimeIds,
  originalStateAdapterEnv,
  noopAsync,
  handleNewMentionMock,
  runtimeState,
} = vi.hoisted(() => {
  const originalStateAdapterEnv = process.env.JUNIOR_STATE_ADAPTER;
  process.env.JUNIOR_STATE_ADAPTER = "memory";
  const observedRuntimeIds = {
    destinationChannelId: undefined as string | undefined,
    juniorBaseUrl: undefined as string | undefined,
    messageThreadId: undefined as string | undefined,
    threadId: undefined as string | undefined,
  };

  return {
    executeAgentRunMock: vi.fn(async () => ({})),
    observedRuntimeIds,
    originalStateAdapterEnv,
    noopAsync: vi.fn(async () => {}),
    runtimeState: {
      agentRunner: undefined as
        | { run: (request: unknown) => Promise<unknown> }
        | undefined,
    },
    handleNewMentionMock: vi.fn(
      async (
        thread: { id: string; post: (value: unknown) => Promise<void> },
        message: { threadId?: string },
        options?: { destination?: { channelId?: string } },
      ) => {
        observedRuntimeIds.destinationChannelId =
          options?.destination?.channelId;
        observedRuntimeIds.juniorBaseUrl = process.env.JUNIOR_BASE_URL;
        observedRuntimeIds.threadId = thread.id;
        observedRuntimeIds.messageThreadId = message.threadId;
        await thread.post("observed");
      },
    ),
    handleSubscribedMessageMock: vi.fn(
      async (
        thread: { id: string; post: (value: unknown) => Promise<void> },
        message: { threadId?: string },
        options?: { destination?: { channelId?: string } },
      ) => {
        observedRuntimeIds.destinationChannelId =
          options?.destination?.channelId;
        observedRuntimeIds.juniorBaseUrl = process.env.JUNIOR_BASE_URL;
        observedRuntimeIds.threadId = thread.id;
        observedRuntimeIds.messageThreadId = message.threadId;
        await thread.post("observed");
      },
    ),
  };
});

vi.mock("@/chat/agent", () => ({
  executeAgentRun: executeAgentRunMock,
}));

vi.mock("@/chat/app/factory", () => ({
  createSlackRuntime: vi.fn(
    (options: {
      services?: {
        replyExecutor?: {
          agentRunner?: { run: (request: unknown) => Promise<unknown> };
        };
      };
    }) => {
      runtimeState.agentRunner = options.services?.replyExecutor?.agentRunner;
      return {
        handleNewMention: handleNewMentionMock,
        handleSubscribedMessage: handleSubscribedMessageMock,
        handleAssistantThreadStarted: noopAsync,
        handleAssistantContextChanged: noopAsync,
      };
    },
  ),
}));

import {
  collectSlackArtifactsFromCapturedCalls,
  runEvalScenario,
} from "../../../src/behavior-harness";

describe("behavior harness", () => {
  afterAll(() => {
    if (originalStateAdapterEnv === undefined) {
      delete process.env.JUNIOR_STATE_ADAPTER;
      return;
    }
    process.env.JUNIOR_STATE_ADAPTER = originalStateAdapterEnv;
  });

  afterEach(() => {
    observedRuntimeIds.destinationChannelId = undefined;
    observedRuntimeIds.juniorBaseUrl = undefined;
    observedRuntimeIds.threadId = undefined;
    observedRuntimeIds.messageThreadId = undefined;
    runtimeState.agentRunner = undefined;
    executeAgentRunMock.mockClear();
    handleNewMentionMock.mockClear();
    handleSubscribedMessageMock.mockClear();
    noopAsync.mockClear();
  });

  it("forwards the host signal into the eval agent policy", async () => {
    const controller = new AbortController();

    await runEvalScenario({ events: [] }, { signal: controller.signal });
    await runtimeState.agentRunner?.run({ policy: {} });

    expect(executeAgentRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        policy: expect.objectContaining({ signal: controller.signal }),
      }),
    );
  });

  it("normalizes eval thread fixtures to Slack-style runtime thread ids", async () => {
    const result = await runEvalScenario({
      events: [
        {
          type: "new_mention",
          thread: {
            id: "fixture-auth-thread",
            channel_id: "CAUTH",
            thread_ts: "1700000000.0001",
          },
          message: {
            id: "m-auth-1",
            text: "hello",
            is_mention: true,
            author: {
              user_id: "UAUTH",
            },
          },
        },
      ],
    });

    expect(handleNewMentionMock).toHaveBeenCalledTimes(1);
    expect(observedRuntimeIds.threadId).toBe("slack:CAUTH:1700000000.0001");
    expect(observedRuntimeIds.messageThreadId).toBe(
      "slack:CAUTH:1700000000.0001",
    );
    expect(result.posts).toEqual([
      {
        channel: "CAUTH",
        files: [],
        text: "observed",
        thread_ts: "1700000000.0001",
      },
    ]);
  });

  it("normalizes eval destinations from adapter channel ids", async () => {
    await runEvalScenario({
      events: [
        {
          type: "new_mention",
          thread: {
            id: "slack:CAUTH:1700000000.0001",
          },
          message: {
            id: "m-auth-1",
            text: "hello",
            is_mention: true,
          },
        },
      ],
    });

    expect(handleNewMentionMock).toHaveBeenCalledTimes(1);
    expect(observedRuntimeIds.destinationChannelId).toBe("CAUTH");
  });

  it("rejects sandbox HTTP interception evals without a tunnel token", async () => {
    const previousBaseUrl = process.env.JUNIOR_BASE_URL;
    const previousTunnelToken = process.env.CLOUDFLARE_TUNNEL_TOKEN;
    process.env.JUNIOR_BASE_URL = "https://junior-eval.example.dev";
    delete process.env.CLOUDFLARE_TUNNEL_TOKEN;
    try {
      await expect(
        runEvalScenario({
          overrides: {
            credential_providers: ["github"],
          },
          events: [],
        }),
      ).rejects.toThrow(
        "Eval sandbox HTTP interception requires CLOUDFLARE_TUNNEL_TOKEN",
      );
    } finally {
      if (previousBaseUrl === undefined) {
        delete process.env.JUNIOR_BASE_URL;
      } else {
        process.env.JUNIOR_BASE_URL = previousBaseUrl;
      }
      if (previousTunnelToken === undefined) {
        delete process.env.CLOUDFLARE_TUNNEL_TOKEN;
      } else {
        process.env.CLOUDFLARE_TUNNEL_TOKEN = previousTunnelToken;
      }
    }
  });

  it("does not retain the tunnel base URL for non-egress evals", async () => {
    const previousBaseUrl = process.env.JUNIOR_BASE_URL;
    process.env.JUNIOR_BASE_URL = "https://junior-eval.example.dev";
    try {
      await runEvalScenario({
        events: [
          {
            type: "new_mention",
            thread: {
              id: "fixture-local-base-url",
              channel_id: "CLOCALBASE",
              thread_ts: "1700000000.0003",
            },
            message: {
              id: "m-local-base-url",
              text: "hello",
              is_mention: true,
            },
          },
        ],
      });

      expect(observedRuntimeIds.juniorBaseUrl).toBe(
        "https://junior.example.com",
      );
    } finally {
      if (previousBaseUrl === undefined) {
        delete process.env.JUNIOR_BASE_URL;
      } else {
        process.env.JUNIOR_BASE_URL = previousBaseUrl;
      }
    }
  });

  it("rejects sandbox HTTP interception evals without a sandbox-reachable base URL", async () => {
    const previousBaseUrl = process.env.JUNIOR_BASE_URL;
    delete process.env.JUNIOR_BASE_URL;
    try {
      await expect(
        runEvalScenario({
          overrides: {
            credential_providers: ["github"],
          },
          events: [],
        }),
      ).rejects.toThrow(
        "Eval sandbox HTTP interception requires JUNIOR_BASE_URL",
      );
    } finally {
      if (previousBaseUrl === undefined) {
        delete process.env.JUNIOR_BASE_URL;
      } else {
        process.env.JUNIOR_BASE_URL = previousBaseUrl;
      }
    }
  });

  it("routes two same-thread mention-shaped events through the queued runtime in order", async () => {
    const thread = {
      id: "fixture-thread",
      channel_id: "CQUEUE",
      thread_ts: "1700000000.0002",
    };

    const result = await runEvalScenario({
      events: [
        {
          type: "new_mention",
          thread,
          message: {
            id: "m-queue-1",
            text: "first",
            is_mention: true,
            author: {
              user_id: "UQUEUE",
            },
          },
        },
        {
          type: "subscribed_message",
          thread,
          message: {
            id: "m-queue-2",
            text: "Second",
            is_mention: true,
            author: {
              user_id: "UQUEUE",
            },
          },
        },
      ],
    });

    expect(handleNewMentionMock).toHaveBeenCalledTimes(1);
    expect(handleSubscribedMessageMock).toHaveBeenCalledTimes(1);
    expect(result.posts).toEqual([
      {
        channel: "CQUEUE",
        files: [],
        text: "observed",
        thread_ts: "1700000000.0002",
      },
      {
        channel: "CQUEUE",
        files: [],
        text: "observed",
        thread_ts: "1700000000.0002",
      },
    ]);
  });

  it("preserves attached file metadata on assistant thread posts", async () => {
    handleNewMentionMock.mockImplementationOnce(
      async (thread: { post: (value: unknown) => Promise<void> }) => {
        await thread.post({
          raw: "",
          files: [
            {
              data: Buffer.from("png"),
              filename: "generated.png",
              mimeType: "image/png",
            },
          ],
        });
      },
    );

    const result = await runEvalScenario({
      events: [
        {
          type: "new_mention",
          thread: {
            id: "fixture-media-thread",
            channel_id: "CMEDIA",
            thread_ts: "1700000000.0003",
          },
          message: {
            id: "m-media-1",
            text: "show me how you feel",
            is_mention: true,
            author: {
              user_id: "UMEDIA",
            },
          },
        },
      ],
    });

    expect(result.posts).toEqual([
      {
        channel: "CMEDIA",
        text: "",
        thread_ts: "1700000000.0003",
        files: [
          {
            filename: "generated.png",
            isImage: true,
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
      },
    ]);
  });

  it("restores cwd when setup fails after creating a plugin fixture", async () => {
    const cwd = process.cwd();

    await expect(
      runEvalScenario({
        events: [],
        overrides: {
          plugin_dirs: ["fixtures/plugins"],
          plugin_packages: ["../bad-package"],
        },
      }),
    ).rejects.toThrow("Plugin package names must be valid npm package names");

    expect(process.cwd()).toBe(cwd);
  });

  it("collects created canvas metadata from captured Slack API calls", () => {
    const artifacts = collectSlackArtifactsFromCapturedCalls([
      {
        method: "canvases.create",
        url: "https://slack.test/api/canvases.create",
        headers: {},
        params: {
          title: "Slack Streaming Timeline",
          document_content: {
            type: "markdown",
            markdown: "## Timeline\n- `chat.startStream`\n- `chat.stopStream`",
          },
        },
      },
      {
        method: "chat.postMessage",
        url: "https://slack.test/api/chat.postMessage",
        headers: {},
        params: {
          channel: "CTEST",
          text: "Created a canvas with the full notes.",
        },
      },
    ]);

    expect(artifacts.canvases).toEqual([
      {
        title: "Slack Streaming Timeline",
        markdown: "## Timeline\n- `chat.startStream`\n- `chat.stopStream`",
      },
    ]);
    expect(artifacts.channelPosts).toEqual([
      {
        channel: "CTEST",
        text: "Created a canvas with the full notes.",
      },
    ]);
  });

  it("collects uploaded Slack files as assistant posts with text and files", () => {
    const artifacts = collectSlackArtifactsFromCapturedCalls([
      {
        method: "files.completeUploadExternal",
        url: "https://slack.test/api/files.completeUploadExternal",
        headers: {},
        params: {
          channel_id: "CTEST",
          thread_ts: "1700000000.0001",
          initial_comment: "Here is the image.",
          files: [{ id: "F1", title: "generated.png" }],
        },
      },
    ]);

    expect(artifacts.filePosts).toEqual([
      {
        channel: "CTEST",
        eventType: "thread_post",
        files: [{ filename: "generated.png", isImage: true }],
        text: "Here is the image.",
        thread_ts: "1700000000.0001",
      },
    ]);
  });
});
