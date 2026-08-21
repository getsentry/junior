import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import type { StateAdapter } from "chat";
import { completeAcpAuthorization } from "@sentry/junior-acp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "@/app";
import {
  ConversationTurnLifecycleService,
  type ConversationTurnLifecycle,
} from "@/chat/conversations/turn-lifecycle";
import { getConversationEventStore } from "@/chat/db";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import {
  closeApiTurnWorkFixture,
  createConversationWorkWebHarness,
} from "../fixtures/api-turn";
import { streamMcpSearch } from "../fixtures/mcp-auth-orchestration";
import {
  ACP_TEST_URL,
  appFetch,
  connectionCookie,
  createIndependentConversationWork,
  initializeAndAuthenticate,
  initializeRequest,
  openAuthenticatedAcpConnection,
  readAcpSseMessage,
  verificationCodeFromElicitation,
  withAcpClient,
} from "../fixtures/acp-http";
import { deferred, streamReplies } from "../fixtures/conversation-work";
import { createModelStream } from "../fixtures/model-stream";
import {
  createPluginAppFixture,
  type PluginAppFixture,
} from "../fixtures/plugin-app";
import { testViewer } from "../fixtures/user";

const EVAL_MCP_PLUGIN_ROOT = path.resolve(
  import.meta.dirname,
  "../fixtures/plugins/eval-auth",
);

describe("remote ACP recovery", () => {
  afterEach(async () => {
    await closeApiTurnWorkFixture();
  });

  it("finishes an authenticate request when browser sign-in expires", async () => {
    const harness = await createConversationWorkWebHarness();
    const app = await createApp({
      conversationWork: harness.conversationWork,
      experimental: { acp: true, subagents: true },
    });
    const initialized = await app.fetch(initializeRequest());
    const connectionId = initialized.headers.get("Acp-Connection-Id");
    if (!connectionId) throw new Error("ACP initialize returned no connection");
    const cookie = connectionCookie(initialized);
    const stream = await app.request(ACP_TEST_URL, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        "Acp-Connection-Id": connectionId,
        Cookie: cookie,
      },
    });
    const reader = stream.body?.getReader();
    if (!reader) throw new Error("ACP GET returned no stream body");
    const requestId = "expired-authenticate";
    const accepted = await app.request(ACP_TEST_URL, {
      method: "POST",
      headers: {
        "Acp-Connection-Id": connectionId,
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method: acp.methods.agent.authenticate,
        params: { methodId: "junior" },
      }),
    });
    expect(accepted.status).toBe(202);

    const buffer = { value: "" };
    const elicitation = await readAcpSseMessage(reader, buffer);
    if (
      !("method" in elicitation) ||
      elicitation.method !== acp.methods.client.elicitation.create
    ) {
      throw new Error("ACP authenticate returned no sign-in elicitation");
    }
    const params = elicitation.params as acp.CreateElicitationRequest;
    if (params.mode !== "url" || typeof params.url !== "string") {
      throw new Error("ACP authenticate returned no sign-in URL");
    }
    const transactionId = new URL(params.url).pathname.split("/").at(-1);
    if (!transactionId)
      throw new Error("ACP sign-in URL has no transaction id");
    const userCode = verificationCodeFromElicitation(params);
    await reader.cancel();
    reader.releaseLock();

    await expect(
      completeAcpAuthorization({
        state: harness.state,
        transactionId,
        user: testViewer(harness.actor.email),
        userCode:
          userCode === "0000-0000-0000" ? "1111-1111-1111" : "0000-0000-0000",
      }),
    ).resolves.toBe("invalid");

    const later = Date.now() + 11 * 60 * 1000;
    const now = vi.spyOn(Date, "now").mockReturnValue(later);
    let completion: Awaited<ReturnType<typeof completeAcpAuthorization>>;
    try {
      completion = await completeAcpAuthorization({
        state: harness.state,
        transactionId,
        user: testViewer(harness.actor.email),
        userCode,
      });
    } finally {
      now.mockRestore();
    }

    expect(completion).toBe("expired");
    const resumedStream = await app.request(ACP_TEST_URL, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        "Acp-Connection-Id": connectionId,
        Cookie: cookie,
      },
    });
    expect(resumedStream.status).toBe(200);
    const resumedReader = resumedStream.body?.getReader();
    if (!resumedReader) throw new Error("ACP GET returned no stream body");
    const resumedBuffer = { value: "" };
    await expect(
      readAcpSseMessage(resumedReader, resumedBuffer),
    ).resolves.toMatchObject({
      method: acp.methods.client.elicitation.complete,
    });
    await expect(
      readAcpSseMessage(resumedReader, resumedBuffer),
    ).resolves.toMatchObject({
      id: requestId,
      error: {
        message: expect.stringContaining("Junior sign-in request expired"),
      },
    });
    await resumedReader.cancel();
    resumedReader.releaseLock();
  });

  it("rejects a second active prompt from another app instance", async () => {
    const modelStarted = deferred();
    const releaseModel = deferred();
    const harness = await createConversationWorkWebHarness({
      modelStream: createModelStream([
        {
          type: "text",
          text: "First prompt complete.",
          onRequest: () => modelStarted.resolve(),
          waitFor: releaseModel.promise,
        },
      ]),
    });
    const app = await createApp({
      conversationWork: harness.conversationWork,
      experimental: { acp: true, subagents: true },
    });
    const secondApp = await createApp({
      conversationWork: createIndependentConversationWork(harness),
      experimental: { acp: true, subagents: true },
    });
    const sessionCreated = deferred<string>();
    const firstPrompt = withAcpClient({
      app,
      email: harness.actor.email,
      run: async (context) => {
        await initializeAndAuthenticate(context);
        const session = await context.request(acp.methods.agent.session.new, {
          cwd: "/client/workspace",
          mcpServers: [],
        });
        sessionCreated.resolve(session.sessionId);
        return await context.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "Keep this prompt active." }],
        });
      },
      state: harness.state,
    });

    const sessionId = await sessionCreated.promise;
    await vi.waitFor(() => {
      expect(harness.queue.hasQueuedMessages()).toBe(true);
    });
    const draining = harness.drain();
    await modelStarted.promise;

    const secondPromptError = await withAcpClient({
      app: secondApp,
      email: harness.actor.email,
      run: async (context) => {
        await initializeAndAuthenticate(context);
        await context.request(acp.methods.agent.session.load, {
          sessionId,
          cwd: "/client/workspace",
          mcpServers: [],
        });
        try {
          await context.request(acp.methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: "text", text: "Do not overlap." }],
          });
          return undefined;
        } catch (error) {
          return error;
        }
      },
      state: harness.state,
    });

    expect(secondPromptError).toMatchObject({ code: -32602 });
    expect(harness.agentRuns).toHaveLength(1);
    releaseModel.resolve();
    await draining;
    await expect(firstPrompt).resolves.toEqual({ stopReason: "end_turn" });
    await expect(harness.historyTexts(sessionId)).resolves.toEqual([
      "Keep this prompt active.",
      "First prompt complete.",
    ]);
  }, 20_000);

  it("rejects another prompt and cancels while the Turn is auth-paused", async () => {
    const originalEnv = { ...process.env };
    let pluginApp: PluginAppFixture | undefined;
    try {
      process.env = {
        ...originalEnv,
        JUNIOR_BASE_URL: "https://junior.example.com",
        JUNIOR_SECRET: "junior-test-secret",
        JUNIOR_STATE_ADAPTER: "memory",
        SLACK_BOT_TOKEN: "xoxb-test-token",
      };
      pluginApp = await createPluginAppFixture([EVAL_MCP_PLUGIN_ROOT]);
      const harness = await createConversationWorkWebHarness({
        modelStream: streamMcpSearch("Auth-paused Turn must not reply."),
      });
      const app = await createApp({
        conversationWork: harness.conversationWork,
        experimental: { acp: true, subagents: true },
      });
      const secondApp = await createApp({
        conversationWork: createIndependentConversationWork(harness),
        experimental: { acp: true, subagents: true },
      });
      const sessionCreated = deferred<string>();
      let cancelActiveTurn: (() => Promise<void>) | undefined;
      const prompt = withAcpClient({
        app,
        email: harness.actor.email,
        run: async (context) => {
          await initializeAndAuthenticate(context);
          const session = await context.request(acp.methods.agent.session.new, {
            cwd: "/client/workspace",
            mcpServers: [],
          });
          sessionCreated.resolve(session.sessionId);
          cancelActiveTurn = async () => {
            await context.notify(acp.methods.agent.session.cancel, {
              sessionId: session.sessionId,
            });
          };
          return await context.request(acp.methods.agent.session.prompt, {
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: "Connect eval-auth first." }],
          });
        },
        state: harness.state,
      });

      const sessionId = await sessionCreated.promise;
      await vi.waitFor(() => {
        expect(harness.queue.hasQueuedMessages()).toBe(true);
      });
      await harness.drain();

      const secondPromptError = await withAcpClient({
        app: secondApp,
        email: harness.actor.email,
        run: async (context) => {
          await initializeAndAuthenticate(context);
          await context.request(acp.methods.agent.session.load, {
            sessionId,
            cwd: "/client/workspace",
            mcpServers: [],
          });
          try {
            await context.request(acp.methods.agent.session.prompt, {
              sessionId,
              prompt: [{ type: "text", text: "Do not overlap." }],
            });
            return undefined;
          } catch (error) {
            return error;
          }
        },
        state: harness.state,
      });

      expect(secondPromptError).toMatchObject({ code: -32602 });
      if (!cancelActiveTurn) {
        throw new Error("ACP cancellation handler was not ready");
      }
      await cancelActiveTurn();
      await harness.drain();

      await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
      expect(harness.agentRuns).toHaveLength(1);
    } finally {
      await pluginApp?.cleanup();
      process.env = originalEnv;
    }
  }, 20_000);

  it("cancels a yielded Turn from another app instance", async () => {
    const harness = await createConversationWorkWebHarness({
      modelStream: createModelStream([
        { type: "toolCall", name: "systemTime", arguments: {} },
        { type: "text", text: "Cancelled resume must not reply." },
      ]),
    });
    const app = await createApp({
      conversationWork: harness.conversationWork,
      experimental: { acp: true, subagents: true },
    });
    const secondApp = await createApp({
      conversationWork: createIndependentConversationWork(harness),
      experimental: { acp: true, subagents: true },
    });
    const sessionCreated = deferred<string>();
    let cancelActiveTurn: (() => Promise<void>) | undefined;
    const prompt = withAcpClient({
      app,
      email: harness.actor.email,
      fetch: appFetch(app, secondApp),
      run: async (context) => {
        await initializeAndAuthenticate(context);
        const session = await context.request(acp.methods.agent.session.new, {
          cwd: "/client/workspace",
          mcpServers: [],
        });
        sessionCreated.resolve(session.sessionId);
        cancelActiveTurn = async () => {
          await context.notify(acp.methods.agent.session.cancel, {
            sessionId: session.sessionId,
          });
        };
        return await context.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "Cancel after this Turn yields." }],
        });
      },
      state: harness.state,
    });

    const sessionId = await sessionCreated.promise;
    await vi.waitFor(() => {
      expect(harness.queue.hasQueuedMessages()).toBe(true);
    });
    await expect(
      processConversationQueueMessage(harness.queue.takeMessage(), {
        ...harness.conversationWork,
        softYieldAfterMs: 0,
      }),
    ).resolves.toMatchObject({ status: "yielded" });
    if (!cancelActiveTurn) {
      throw new Error("ACP cancellation handler was not ready");
    }
    await cancelActiveTurn();
    await harness.drain();

    await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
    await expect(harness.historyTexts(sessionId)).resolves.toEqual([
      "Cancel after this Turn yields.",
    ]);
  }, 20_000);

  it("holds terminal output until acknowledgement, then accepts a follow-up", async () => {
    const terminalPersisted = deferred();
    const releaseWorker = deferred();
    const persistedLifecycle = new ConversationTurnLifecycleService(
      getConversationEventStore(),
    );
    let blockFirstCompletion = true;
    const turnLifecycle = {
      start: async (input) => await persistedLifecycle.start(input),
      complete: async (input) => {
        await persistedLifecycle.complete(input);
        if (!blockFirstCompletion) return;
        blockFirstCompletion = false;
        terminalPersisted.resolve();
        await releaseWorker.promise;
      },
      fail: async (input) => await persistedLifecycle.fail(input),
    } satisfies ConversationTurnLifecycle;
    const harness = await createConversationWorkWebHarness({
      modelStream: streamReplies("Follow-up complete."),
      turnLifecycle,
    });
    let observePendingRead = false;
    let pendingReadObserved = false;
    let sessionStateKey: string | undefined;
    const observedState = new Proxy(harness.state, {
      get(target, property, receiver) {
        if (property === "get") {
          return async (key: string) => {
            const value = await target.get(key);
            if (
              observePendingRead &&
              key === sessionStateKey &&
              typeof value === "object" &&
              value !== null &&
              "execution" in value &&
              typeof value.execution === "object" &&
              value.execution !== null &&
              "pendingMessages" in value.execution &&
              Array.isArray(value.execution.pendingMessages) &&
              value.execution.pendingMessages.length > 0
            ) {
              pendingReadObserved = true;
            }
            return value;
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as StateAdapter;
    const app = await createApp({
      conversationWork: {
        ...harness.conversationWork,
        state: observedState,
      },
      experimental: { acp: true, subagents: true },
    });
    const secondApp = await createApp({
      conversationWork: createIndependentConversationWork(harness),
      experimental: { acp: true, subagents: true },
    });
    const sessionCreated = deferred<string>();
    const secondPromptPosted = deferred();
    let workerReleased = false;
    let followUpPostedBeforeAcknowledgement = false;
    let cancelActiveTurn: (() => Promise<void>) | undefined;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init as RequestInit);
      let isFollowUp = false;
      if (request.method === "POST") {
        const body: unknown = await request.clone().json();
        isFollowUp =
          typeof body === "object" &&
          body !== null &&
          "method" in body &&
          body.method === acp.methods.agent.session.prompt &&
          "params" in body &&
          typeof body.params === "object" &&
          body.params !== null &&
          "prompt" in body.params &&
          Array.isArray(body.params.prompt) &&
          body.params.prompt.some(
            (block) =>
              typeof block === "object" &&
              block !== null &&
              "text" in block &&
              block.text === "Immediate follow-up.",
          );
      }
      if (isFollowUp && !workerReleased) {
        followUpPostedBeforeAcknowledgement = true;
      }
      const response = await app.fetch(request);
      if (isFollowUp) secondPromptPosted.resolve();
      return response;
    };
    const prompts = withAcpClient({
      app,
      email: harness.actor.email,
      fetch,
      run: async (context) => {
        await initializeAndAuthenticate(context);
        const session = await context.request(acp.methods.agent.session.new, {
          cwd: "/client/workspace",
          mcpServers: [],
        });
        sessionStateKey = `junior:conversation:v2:${session.sessionId}`;
        sessionCreated.resolve(session.sessionId);
        cancelActiveTurn = async () => {
          await context.notify(acp.methods.agent.session.cancel, {
            sessionId: session.sessionId,
          });
        };
        const first = await context.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "Cancel before input commit." }],
        });
        const second = await context.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "Immediate follow-up." }],
        });
        return { first, second };
      },
      state: harness.state,
    });

    const sessionId = await sessionCreated.promise;
    await vi.waitFor(() => {
      expect(harness.queue.hasQueuedMessages()).toBe(true);
    });
    if (!cancelActiveTurn) {
      throw new Error("ACP cancellation handler was not ready");
    }
    await cancelActiveTurn();
    const draining = harness.drain();
    await terminalPersisted.promise;
    observePendingRead = true;
    await vi.waitFor(() => {
      expect(pendingReadObserved).toBe(true);
    });
    expect(followUpPostedBeforeAcknowledgement).toBe(false);

    let prematurePromptError: unknown;
    try {
      prematurePromptError = await withAcpClient({
        app: secondApp,
        email: harness.actor.email,
        run: async (context) => {
          await initializeAndAuthenticate(context);
          await context.request(acp.methods.agent.session.load, {
            sessionId,
            cwd: "/client/workspace",
            mcpServers: [],
          });
          try {
            await context.request(acp.methods.agent.session.prompt, {
              sessionId,
              prompt: [{ type: "text", text: "Do not run before ack." }],
            });
            return undefined;
          } catch (error) {
            return error;
          }
        },
        state: harness.state,
      });
    } finally {
      workerReleased = true;
      releaseWorker.resolve();
    }
    expect(prematurePromptError).toMatchObject({ code: -32602 });
    expect(harness.agentRuns).toHaveLength(0);

    await secondPromptPosted.promise;
    await draining;
    await harness.drain();

    await expect(prompts).resolves.toEqual({
      first: { stopReason: "cancelled" },
      second: { stopReason: "end_turn" },
    });
    await expect(harness.historyTexts(sessionId)).resolves.toEqual([
      "Cancel before input commit.",
      "Immediate follow-up.",
      "Follow-up complete.",
    ]);
  }, 20_000);

  it("recovers prompt admission after the first queue send fails", async () => {
    const harness = await createConversationWorkWebHarness({
      modelStream: streamReplies("Recovered queue reply."),
    });
    const app = await createApp({
      conversationWork: harness.conversationWork,
      experimental: { acp: true, subagents: true },
    });
    const secondApp = await createApp({
      conversationWork: createIndependentConversationWork(harness),
      experimental: { acp: true, subagents: true },
    });
    const sessionId = await withAcpClient({
      app,
      email: harness.actor.email,
      run: async (context) => {
        await initializeAndAuthenticate(context);
        const session = await context.request(acp.methods.agent.session.new, {
          cwd: "/client/workspace",
          mcpServers: [],
        });
        return session.sessionId;
      },
      state: harness.state,
    });
    const { connectionId, cookie } = await openAuthenticatedAcpConnection({
      app,
      email: harness.actor.email,
      state: harness.state,
    });
    const promptRequest = () =>
      new Request(ACP_TEST_URL, {
        method: "POST",
        headers: {
          "Acp-Connection-Id": connectionId,
          "Acp-Session-Id": sessionId,
          "Content-Type": "application/json",
          Cookie: cookie,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: acp.methods.agent.session.prompt,
          params: {
            sessionId,
            prompt: [{ type: "text", text: "Recover this prompt." }],
          },
        }),
      });

    harness.queue.rejectSends();
    const failed = await app.fetch(promptRequest());
    expect(failed.status).toBe(500);
    expect(harness.queue.hasQueuedMessages()).toBe(false);

    harness.queue.allowSends();
    const retried = await secondApp.fetch(promptRequest());
    expect(retried.status).toBe(202);
    await vi.waitFor(() => {
      expect(harness.queue.hasQueuedMessages()).toBe(true);
    });
    await harness.drain();
    await expect(harness.historyTexts(sessionId)).resolves.toEqual([
      "Recover this prompt.",
      "Recovered queue reply.",
    ]);
  }, 20_000);
});
