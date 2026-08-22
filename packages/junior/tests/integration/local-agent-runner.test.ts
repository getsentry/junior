import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  defineJuniorPlugin,
  type PluginRunContext,
} from "@sentry/junior-plugin-api";
import { normalizeLocalConversationId } from "@/chat/local/conversation";
import {
  runLocalAgentTurn,
  type LocalAgentReply,
  type LocalAgentTurnDeps,
  type LocalToolInvocation,
  type LocalToolResult,
} from "@/chat/local/runner";
import type { PiMessage } from "@/chat/pi/messages";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import type { AgentRun } from "@/chat/agent/types";
import {
  getPersistedSandboxState,
  getPersistedThreadState,
} from "@/chat/runtime/thread-state";
import {
  commitMessages,
  loadProjection,
} from "@/chat/conversations/projection";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { hydrateConversationMessages } from "@/chat/conversations/messages";
import { setPlugins } from "@/chat/plugins/agent-hooks";
import { NO_REPLY_MARKER } from "@/chat/no-reply";
import { getMcpStoredOAuthCredentials } from "@/chat/mcp/auth-store";
import { startLocalOAuthCallbackServer } from "@/chat/local/oauth-callback-server";
import { createLocalOAuthState } from "@/chat/local/oauth-relay";
import { getTurnRecord } from "@/chat/task-execution/checkpoint";
import {
  createModelAgentRunnerForRun,
  neverRunAgentRunner,
} from "../fixtures/agent-runner";
import { createModelStream } from "../fixtures/model-stream";
import { runMcpOauthCallbackRoute } from "../fixtures/mcp-oauth-callback-harness";
import { createPluginAppFixture } from "../fixtures/plugin-app";
import { EVAL_MCP_AUTH_PROVIDER } from "../msw/handlers/eval-mcp-auth";
import { getConversationEventStore } from "@/chat/db";

const EVAL_MCP_PLUGIN_ROOT = path.resolve(
  import.meta.dirname,
  "../fixtures/plugins/eval-auth",
);

function userPiMessage(text: string, timestamp = 1): PiMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  } as PiMessage;
}

function assistantPiMessage(text: string, timestamp = 1): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "fake-local-agent",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp,
  };
}

async function loadLifecycleEvents(conversationId: string) {
  return (await getConversationEventStore().loadHistory(conversationId)).filter(
    (event) => event.data.type.startsWith("turn_"),
  );
}

type CapturedAgentRun = AgentRun;

describe("local agent runner", () => {
  it("runs a local message without Slack actor or destination state", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "demo",
      cwd: "/tmp/local-agent-runner-one",
    });
    expect(conversationId).toBeDefined();

    const agentRuns: CapturedAgentRun[] = [];
    const agentRunner = createModelAgentRunnerForRun((run) => {
      agentRuns.push(run);
      return createModelStream([{ type: "text", text: "hello from local" }]);
    });
    const delivered: LocalAgentReply[] = [];

    await runLocalAgentTurn(
      {
        conversationId: conversationId!,
        message: "hello",
      },
      {
        deliverReply: async (reply) => {
          delivered.push(reply);
        },
        agentRunner,
      },
    );

    expect(agentRuns).toHaveLength(1);
    expect(agentRuns[0]).toEqual(
      expect.objectContaining({
        instruction: expect.objectContaining({ text: "hello" }),
        disabledFeatures: ["interactive-auth"],
        credentialContext: {
          actor: { type: "user", userId: "local-cli" },
        },
        destination: {
          platform: "local",
          conversationId,
        },
        surface: "internal",
      }),
    );
    expect(agentRuns[0]?.actor).toEqual({
      fullName: "Local CLI",
      platform: "local",
      userId: "local-cli",
      userName: "local",
    });
    expect(agentRuns[0]?.slackConversation).toBeUndefined();
    expect(delivered).toEqual([
      {
        text: "hello from local",
      },
    ]);

    const state = await getPersistedThreadState(conversationId!);
    const conversation = coerceThreadConversationState(state);
    await hydrateConversationMessages({
      conversation,
      conversationId: conversationId!,
    });
    expect(conversation.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(conversation.messages[0]).toMatchObject({
      text: "hello",
      author: {
        userId: "local-cli",
        userName: "local",
      },
      meta: {
        replied: true,
      },
    });
    expect(conversation.messages[1]).toMatchObject({
      text: "hello from local",
      author: {
        isBot: true,
      },
      meta: {
        replied: true,
      },
    });

    const history = await getConversationEventStore().loadHistory(
      conversationId!,
    );
    const userRecorded = history.findIndex(
      (event) => event.data.type === "message" && event.data.role === "user",
    );
    const started = history.findIndex(
      (event) => event.data.type === "turn_started",
    );
    const assistantRecorded = history.findIndex(
      (event) =>
        event.data.type === "message" && event.data.role === "assistant",
    );
    const completed = history.findIndex(
      (event) => event.data.type === "turn_completed",
    );
    expect(userRecorded).toBeLessThan(started);
    expect(started).toBeLessThan(assistantRecorded);
    expect(assistantRecorded).toBeLessThan(completed);
    expect(history[completed]?.data).toMatchObject({
      type: "turn_completed",
      outcome: "success",
    });
  });

  it("waits for local OAuth and resumes the same turn", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "oauth-resume",
      cwd: "/tmp/local-agent-runner-oauth-resume",
    });
    expect(conversationId).toBeDefined();
    const previousBaseUrl = process.env.JUNIOR_BASE_URL;
    process.env.JUNIOR_BASE_URL = "https://junior.example.com";
    const pluginApp = await createPluginAppFixture([EVAL_MCP_PLUGIN_ROOT]);
    let oauthCallback:
      | Awaited<ReturnType<typeof startLocalOAuthCallbackServer>>
      | undefined;

    try {
      const requests: Parameters<AgentRunner["run"]>[0][] = [];
      const authorizationRequests: Parameters<
        NonNullable<LocalAgentTurnDeps["authorization"]>["deliver"]
      >[0][] = [];
      const delivered: LocalAgentReply[] = [];
      const agentRunner = createModelAgentRunnerForRun((request) => {
        requests.push(request);
        return createModelStream([
          {
            type: "toolCall",
            name: "searchMcpTools",
            arguments: {
              provider: EVAL_MCP_AUTH_PROVIDER,
              query: "budget echo",
            },
          },
          { type: "text", text: "Eval Auth is connected." },
        ]);
      });
      oauthCallback = await startLocalOAuthCallbackServer(agentRunner);
      const completeAuthorization = async (authorizationUrl: string) => {
        const providerResponse = await fetch(authorizationUrl, {
          redirect: "manual",
        });
        const providerLocation = providerResponse.headers.get("location");
        expect(providerResponse.status).toBe(302);
        expect(providerLocation).toEqual(expect.any(String));
        const providerCallback = new URL(providerLocation!);
        const state = providerCallback.searchParams.get("state");
        const code = providerCallback.searchParams.get("code");
        expect(state).toEqual(expect.any(String));
        expect(code).toEqual(expect.any(String));

        const relayResponse = await runMcpOauthCallbackRoute({
          provider: EVAL_MCP_AUTH_PROVIDER,
          state: state!,
          code: code!,
          agentRunner: neverRunAgentRunner(),
          expectBackgroundWork: false,
        });
        const localCallbackUrl = relayResponse.headers.get("location");
        expect(relayResponse.status).toBe(302);
        expect(localCallbackUrl).toEqual(expect.any(String));
        await expect(fetch(localCallbackUrl!)).resolves.toMatchObject({
          status: 200,
        });
      };

      await runLocalAgentTurn(
        {
          conversationId: conversationId!,
          message: "connect eval-auth",
        },
        {
          agentRunner,
          authorization: {
            cancel: oauthCallback.cancelAuthorization,
            createState: async () =>
              await createLocalOAuthState(oauthCallback!.port),
            deliver: async (request) => {
              authorizationRequests.push(request);
              oauthCallback!.beginAuthorization(request.authorizationUrl);
              await completeAuthorization(request.authorizationUrl);
            },
            wait: oauthCallback.waitForAuthorization,
          },
          deliverReply: async (reply) => {
            delivered.push(reply);
          },
        },
      );

      expect(authorizationRequests).toEqual([
        expect.objectContaining({
          authorizationUrl: expect.stringContaining(
            "https://eval-auth.example.test/oauth/authorize",
          ),
        }),
      ]);
      expect(requests).toHaveLength(2);
      expect(requests[0]?.turnId).toBe(requests[1]?.turnId);
      expect(requests[0]?.runId).not.toBe(requests[1]?.runId);
      expect(requests[0]?.disabledFeatures).toBeUndefined();
      expect(requests[0]?.authorization).toBeDefined();
      expect(requests[1]?.state?.pendingAuth).toMatchObject({
        kind: "mcp",
        provider: EVAL_MCP_AUTH_PROVIDER,
        actorId: "local-cli",
      });
      expect(delivered).toEqual([{ text: "Eval Auth is connected." }]);
      await expect(
        getMcpStoredOAuthCredentials("local-cli", EVAL_MCP_AUTH_PROVIDER),
      ).resolves.toMatchObject({
        tokens: expect.objectContaining({ access_token: expect.any(String) }),
      });
      await expect(
        getTurnRecord(conversationId!, requests[0]!.turnId),
      ).resolves.toMatchObject({
        state: "completed",
        sliceId: 2,
        piMessages: expect.arrayContaining([
          expect.objectContaining({
            role: "toolResult",
            toolName: "searchMcpTools",
            isError: false,
          }),
        ]),
      });
      const state = coerceThreadConversationState(
        await getPersistedThreadState(conversationId!),
      );
      expect(state.processing.pendingAuth).toBeUndefined();
    } finally {
      await oauthCallback?.close();
      await pluginApp.cleanup();
      if (previousBaseUrl === undefined) {
        delete process.env.JUNIOR_BASE_URL;
      } else {
        process.env.JUNIOR_BASE_URL = previousBaseUrl;
      }
    }
  });

  it("records intentional silence without delivering or inventing a message", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "no-reply",
      cwd: "/tmp/local-agent-runner-no-reply",
    });
    const deliverReply = vi.fn<LocalAgentTurnDeps["deliverReply"]>();

    await runLocalAgentTurn(
      { conversationId: conversationId!, message: "react only" },
      {
        agentRunner: createModelAgentRunnerForRun(() =>
          createModelStream([{ type: "text", text: NO_REPLY_MARKER }]),
        ),
        deliverReply,
      },
    );

    expect(deliverReply).not.toHaveBeenCalled();
    const state = await getPersistedThreadState(conversationId!);
    const conversation = coerceThreadConversationState(state);
    await hydrateConversationMessages({
      conversation,
      conversationId: conversationId!,
    });
    expect(conversation.messages.map((message) => message.text)).toEqual([
      "react only",
    ]);
    expect(JSON.stringify(conversation.messages)).not.toContain(
      "[no visible reply]",
    );
    const lifecycle = await loadLifecycleEvents(conversationId!);
    expect(lifecycle[0]?.data).toMatchObject({ type: "turn_started" });
    expect(lifecycle.at(-1)?.data).toMatchObject({
      type: "turn_completed",
      outcome: "no_reply",
    });
  });

  it("records a delivered sanitized model failure without raw error data", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "model-failure",
      cwd: "/tmp/local-agent-runner-model-failure",
    });
    const rawError =
      "upstream request failed: raw-error-sentinel https://provider.invalid/private?token=secret";
    const delivered: LocalAgentReply[] = [];

    await runLocalAgentTurn(
      { conversationId: conversationId!, message: "please try" },
      {
        agentRunner: createModelAgentRunnerForRun(() =>
          createModelStream([{ type: "error", errorMessage: rawError }]),
        ),
        deliverReply: async (reply) => {
          delivered.push(reply);
        },
      },
    );

    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.text).toContain("temporary connection problem");
    expect(delivered[0]?.text).not.toContain("raw-error-sentinel");
    const lifecycle = await loadLifecycleEvents(conversationId!);
    expect(lifecycle.at(-1)?.data).toMatchObject({
      type: "turn_failed",
      turnId: expect.stringMatching(/^local-turn-/),
      failureCode: "model_execution_failed",
    });
    expect(JSON.stringify(lifecycle)).not.toContain("raw-error-sentinel");
    expect(JSON.stringify(lifecycle)).not.toContain("provider.invalid");
  });

  it("classifies a thrown agent run without persisting exception details", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "runner-throw",
      cwd: "/tmp/local-agent-runner-throw",
    });
    const rawError = "raw-run-error-sentinel token=secret";
    const cancelAuthorization = vi.fn();

    await expect(
      runLocalAgentTurn(
        { conversationId: conversationId!, message: "please try" },
        {
          authorization: {
            cancel: cancelAuthorization,
            createState: vi.fn(async () => "local-oauth-state"),
            deliver: vi.fn(),
            wait: vi.fn(),
          },
          agentRunner: createModelAgentRunnerForRun(() => {
            throw new Error(rawError);
          }),
          deliverReply: async () => undefined,
        },
      ),
    ).rejects.toThrow(rawError);

    const lifecycle = await loadLifecycleEvents(conversationId!);
    expect(lifecycle.at(-1)?.data).toMatchObject({
      type: "turn_failed",
      failureCode: "agent_run_failed",
    });
    expect(cancelAuthorization).toHaveBeenCalledOnce();
    expect(JSON.stringify(lifecycle)).not.toContain(rawError);
  });

  it("forwards tool events from the shared reply boundary", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "tools",
      cwd: "/tmp/local-agent-runner-tools",
    });
    expect(conversationId).toBeDefined();

    const agentRunner = createModelAgentRunnerForRun(() =>
      createModelStream([
        { type: "toolCall", name: "systemTime", arguments: {} },
        { type: "text", text: "Time checked." },
      ]),
    );
    const invocations: LocalToolInvocation[] = [];
    const results: LocalToolResult[] = [];

    await runLocalAgentTurn(
      {
        conversationId: conversationId!,
        message: "check the current time",
      },
      {
        deliverReply: async () => undefined,
        agentRunner,
        onToolInvocation: async (invocation) => {
          invocations.push(invocation);
        },
        onToolResult: async (result) => {
          results.push(result);
        },
      },
    );

    expect(invocations).toEqual([
      {
        toolName: "systemTime",
        params: {},
      },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      ok: true,
      toolCallId: expect.any(String),
      toolName: "systemTime",
      params: {},
      result: {
        unix_ms: expect.any(Number),
        iso_utc: expect.any(String),
        iso_local: expect.any(String),
        timezone: null,
        timezone_offset_minutes: expect.any(Number),
      },
    });
  });

  it("runs plugin tasks inline after completed local turns", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "plugin-task",
      cwd: "/tmp/local-agent-runner-plugin-task",
    });
    expect(conversationId).toBeDefined();

    const loadedRuns: PluginRunContext[] = [];
    const { setPlugins } = await import("@/chat/plugins/agent-hooks");
    setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "local-task-demo",
          displayName: "Local Task Demo",
          description: "Local task demo",
        },
        tasks: {
          captureSession: {
            async run(ctx) {
              loadedRuns.push(await ctx.run.load());
            },
          },
        },
      }),
    ]);

    try {
      await runLocalAgentTurn(
        {
          conversationId: conversationId!,
          message: "capture this local turn",
        },
        {
          deliverReply: async () => undefined,
          agentRunner: createModelAgentRunnerForRun(() =>
            createModelStream([{ type: "text", text: "captured" }]),
          ),
        },
      );
    } finally {
      setPlugins([]);
    }

    expect(loadedRuns).toEqual([
      expect.objectContaining({
        conversationId,
        destination: {
          platform: "local",
          conversationId,
        },
        runId: expect.stringMatching(/^local-turn-[0-9a-f-]{36}$/),
        transcript: [
          {
            type: "message",
            role: "user",
            text: "capture this local turn",
            isRunActor: true,
            provenance: {
              authority: "instruction",
              actor: expect.objectContaining({
                platform: "local",
                userId: "local-cli",
              }),
            },
          },
          {
            type: "message",
            role: "assistant",
            text: "captured",
          },
        ],
        actor: expect.objectContaining({
          platform: "local",
          userId: "local-cli",
        }),
        actors: [
          expect.objectContaining({
            platform: "local",
            userId: "local-cli",
          }),
        ],
        source: {
          platform: "local",
          visibility: "private",
          conversationId,
        },
      }),
    ]);
  });

  it("preserves visible local conversation context across messages", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "followup",
      cwd: "/tmp/local-agent-runner-two",
    });
    expect(conversationId).toBeDefined();

    const agentRuns: CapturedAgentRun[] = [];
    const agentRunner = createModelAgentRunnerForRun((run) => {
      agentRuns.push(run);
      return createModelStream([
        { type: "text", text: `reply to ${run.instruction.text}` },
      ]);
    });

    await runLocalAgentTurn(
      {
        conversationId: conversationId!,
        message: "first question",
      },
      {
        deliverReply: async () => undefined,
        agentRunner,
      },
    );
    await runLocalAgentTurn(
      {
        conversationId: conversationId!,
        message: "second question",
      },
      {
        deliverReply: async () => undefined,
        agentRunner,
      },
    );

    expect(agentRuns[1]?.instruction.context).toContain("first question");
    expect(agentRuns[1]?.instruction.context).toContain(
      "reply to first question",
    );

    const state = await getPersistedThreadState(conversationId!);
    expect(state.conversation).not.toHaveProperty("stats");
    expect(state.conversation).not.toHaveProperty("backfill");
    const conversation = coerceThreadConversationState(state);
    await hydrateConversationMessages({
      conversation,
      conversationId: conversationId!,
    });
    expect(conversation.messages.map((message) => message.text)).toEqual([
      "first question",
      "reply to first question",
      "second question",
      "reply to second question",
    ]);
  });

  it("rejects malformed local conversation ids before generation", async () => {
    await expect(
      runLocalAgentTurn(
        {
          conversationId: "slack:C123:123.456",
          message: "hello",
        },
        {
          deliverReply: async () => undefined,
          agentRunner: neverRunAgentRunner(),
        },
      ),
    ).rejects.toThrow("Invalid local conversation id");
  });

  it("commits generated Pi history after successful local delivery", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "pi-history-commit",
      cwd: "/tmp/local-agent-runner-six",
    });
    expect(conversationId).toBeDefined();

    const firstAgentRunner = createModelAgentRunnerForRun(() =>
      createModelStream([{ type: "text", text: "persisted visible output" }]),
    );

    await runLocalAgentTurn(
      {
        conversationId: conversationId!,
        message: "hello",
      },
      {
        deliverReply: async () => undefined,
        agentRunner: firstAgentRunner,
      },
    );

    const generatedMessages = await loadProjection({
      conversationId: conversationId!,
    });
    expect(generatedMessages).toEqual([
      expect.objectContaining({
        role: "user",
        content: [
          {
            type: "text",
            text: expect.stringContaining("hello"),
          },
        ],
      }),
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "persisted visible output" }],
      }),
    ]);

    const agentRuns: CapturedAgentRun[] = [];
    const followUpAgentRunner = createModelAgentRunnerForRun((run) => {
      agentRuns.push(run);
      return createModelStream([{ type: "text", text: "follow up reply" }]);
    });
    await runLocalAgentTurn(
      {
        conversationId: conversationId!,
        message: "follow up",
      },
      {
        deliverReply: async () => undefined,
        agentRunner: followUpAgentRunner,
      },
    );

    expect(agentRuns[0]?.history).toEqual(generatedMessages);
  });

  it("keeps the delivered local reply successful when a background task fails", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "background-task-failure",
      cwd: "/tmp/local-agent-runner-background-task-failure",
    });
    expect(conversationId).toBeDefined();

    const delivered: LocalAgentReply[] = [];
    let taskRuns = 0;
    setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "local-task-failure",
          displayName: "Local Task Failure",
          description: "Local task failure fixture",
        },
        tasks: {
          processSession: {
            run() {
              taskRuns += 1;
              throw new Error("background task failed");
            },
          },
        },
      }),
    ]);

    try {
      await expect(
        runLocalAgentTurn(
          {
            conversationId: conversationId!,
            message: "hello",
          },
          {
            deliverReply: async (reply) => {
              delivered.push(reply);
            },
            agentRunner: createModelAgentRunnerForRun(() =>
              createModelStream([{ type: "text", text: "visible reply" }]),
            ),
          },
        ),
      ).resolves.toEqual({
        conversationId,
        outcome: "success",
      });
    } finally {
      setPlugins([]);
    }

    expect(delivered).toEqual([{ text: "visible reply" }]);
    expect(taskRuns).toBe(1);
  });

  it("uses the SQL step projection as the Pi history authority", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "pi-history-projection-authority",
      cwd: "/tmp/local-agent-runner-seven",
    });
    expect(conversationId).toBeDefined();

    const projectedMessages = [
      userPiMessage("projected question"),
      assistantPiMessage("projected answer", 2),
      userPiMessage("projected follow-up", 3),
    ];
    await commitMessages({
      conversationId: conversationId!,
      messages: projectedMessages,
    });

    const agentRuns: CapturedAgentRun[] = [];
    const agentRunner = createModelAgentRunnerForRun((run) => {
      agentRuns.push(run);
      return createModelStream([{ type: "text", text: "uses projection" }]);
    });
    await runLocalAgentTurn(
      {
        conversationId: conversationId!,
        message: "follow up",
      },
      {
        deliverReply: async () => undefined,
        agentRunner,
      },
    );

    expect(agentRuns[0]?.history).toEqual(projectedMessages);
  });

  it("does not commit generated Pi output when local delivery fails", async () => {
    const conversationId = normalizeLocalConversationId({
      alias: "delivery-pi-rollback",
      cwd: "/tmp/local-agent-runner-five",
    });
    expect(conversationId).toBeDefined();
    const rawDeliveryError = "raw-delivery-error-sentinel stdout closed";

    const realAgentRunner = createModelAgentRunnerForRun(() =>
      createModelStream([{ type: "text", text: "not delivered" }]),
    );
    const agentRunner: AgentRunner = {
      run: async (request) => {
        await request.durability?.onSandboxRefChanged?.({
          id: "sandbox-undelivered",
          profileHash: "profile-undelivered",
        });
        return await realAgentRunner.run(request);
      },
    };

    await expect(
      runLocalAgentTurn(
        {
          conversationId: conversationId!,
          message: "hello",
        },
        {
          deliverReply: async () => {
            throw new Error(rawDeliveryError);
          },
          agentRunner,
        },
      ),
    ).rejects.toThrow(rawDeliveryError);

    const projection = await loadProjection({
      conversationId: conversationId!,
    });
    expect(projection).toEqual([
      expect.objectContaining({
        role: "user",
        content: expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("hello"),
          }),
        ]),
      }),
    ]);
    expect(projection.some((message) => message.role === "assistant")).toBe(
      false,
    );
    const state = await getPersistedThreadState(conversationId!);
    expect(getPersistedSandboxState(state)).toBeUndefined();
    const visible = coerceThreadConversationState(state);
    await hydrateConversationMessages({
      conversation: visible,
      conversationId: conversationId!,
    });
    expect(visible.messages).toEqual([
      expect.objectContaining({ role: "user", text: "hello" }),
    ]);
    const lifecycle = await loadLifecycleEvents(conversationId!);
    expect(lifecycle.at(-1)?.data).toMatchObject({
      type: "turn_failed",
      failureCode: "delivery_failed",
    });
    expect(JSON.stringify(lifecycle)).not.toContain(rawDeliveryError);
  });
});
