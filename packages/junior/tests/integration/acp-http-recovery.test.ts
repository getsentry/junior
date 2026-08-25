import { createHash } from "node:crypto";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import type { StateAdapter } from "chat";
import { completeAcpAuthorization } from "@/api/acp/auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "@/app";
import { createAcpConversations } from "@/api/acp/conversations";
import {
  ConversationTurnLifecycleService,
  type ConversationTurnLifecycle,
} from "@/chat/conversations/turn-lifecycle";
import { getConversationEventStore } from "@/chat/db";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import { recordConversationExecution } from "@/chat/task-execution/state";
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
  mockAcpDashboardConfig,
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
import { readProxyProperty } from "../fixtures/proxy-property";
import { testViewer } from "../fixtures/user";

mockAcpDashboardConfig();

const EVAL_MCP_PLUGIN_ROOT = path.resolve(
  import.meta.dirname,
  "../fixtures/plugins/eval-auth",
);

describe("remote ACP recovery", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    await closeApiTurnWorkFixture();
  });

  it("finishes an abandoned authenticate request when browser sign-in expires", async () => {
    vi.stubEnv("JUNIOR_BASE_URL", "");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "junior.example.com");
    vi.stubEnv("VERCEL_URL", "preview.example.com");
    const harness = await createConversationWorkWebHarness();
    const app = await createApp({
      conversationWork: harness.conversationWork,
      dashboard: {
        authRequired: false,
      },
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
    const authorizationURL = new URL(params.url);
    expect(authorizationURL.origin).toBe("https://junior.example.com");
    const transactionId = authorizationURL.pathname.split("/").at(-1);
    if (!transactionId)
      throw new Error("ACP sign-in URL has no transaction id");
    const userCode = verificationCodeFromElicitation(params);

    await expect(
      completeAcpAuthorization({
        state: harness.state,
        transactionId,
        user: testViewer(harness.actor.email),
        userCode:
          userCode === "0000-0000-0000" ? "1111-1111-1111" : "0000-0000-0000",
      }),
    ).resolves.toBe("invalid");

    const authorizationKey = `junior:acp:v1:authorization:${transactionId}`;
    const authorization =
      await harness.state.get<Record<string, unknown>>(authorizationKey);
    if (!authorization) {
      throw new Error("ACP sign-in transaction was not stored");
    }
    const expiresAtMs = Date.now() - 1;
    await harness.state.set(authorizationKey, {
      ...authorization,
      expiresAtMs,
    });
    await harness.state.set(
      `junior:acp:v1:connection:${connectionId}:authorization`,
      { expiresAtMs, transactionId },
    );

    await expect(readAcpSseMessage(reader, buffer)).resolves.toMatchObject({
      method: acp.methods.client.elicitation.complete,
    });
    await expect(readAcpSseMessage(reader, buffer)).resolves.toMatchObject({
      id: requestId,
      error: {
        message: expect.stringContaining("Junior sign-in request expired"),
      },
    });

    await expect(
      completeAcpAuthorization({
        state: harness.state,
        transactionId,
        user: testViewer(harness.actor.email),
        userCode,
      }),
    ).resolves.toBe("expired");
    await reader.cancel();
    reader.releaseLock();
  });

  it("rejects an untrusted request origin before starting browser sign-in", async () => {
    vi.stubEnv("JUNIOR_BASE_URL", "");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "");
    vi.stubEnv("VERCEL_URL", "");
    const harness = await createConversationWorkWebHarness();
    const app = await createApp({
      conversationWork: harness.conversationWork,
      dashboard: { authRequired: false },
    });
    const attackerURL = "https://attacker.example/api/acp";
    const baseInitialize = initializeRequest();
    const initialized = await app.fetch(
      new Request(attackerURL, {
        body: await baseInitialize.text(),
        headers: baseInitialize.headers,
        method: baseInitialize.method,
      }),
    );
    const connectionId = initialized.headers.get("Acp-Connection-Id");
    if (!connectionId) throw new Error("ACP initialize returned no connection");
    const cookie = connectionCookie(initialized);
    const stream = await app.fetch(
      new Request(attackerURL, {
        headers: {
          Accept: "text/event-stream",
          "Acp-Connection-Id": connectionId,
          Cookie: cookie,
        },
      }),
    );
    const reader = stream.body?.getReader();
    if (!reader) throw new Error("ACP GET returned no stream body");
    const requestId = "untrusted-origin-authenticate";
    const accepted = await app.fetch(
      new Request(attackerURL, {
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
      }),
    );
    expect(accepted.status).toBe(202);

    const message = await readAcpSseMessage(reader, { value: "" });
    expect(message).toMatchObject({
      id: requestId,
      error: {
        message: expect.stringContaining("configured public base URL"),
      },
    });
    expect(JSON.stringify(message)).not.toContain("attacker.example");
    await expect(
      harness.state.get(
        `junior:acp:v1:connection:${connectionId}:authorization`,
      ),
    ).resolves.toBeNull();
    await reader.cancel();
    reader.releaseLock();
  });

  it("rejects a second authenticate request without replacing the pending sign-in", async () => {
    const harness = await createConversationWorkWebHarness();
    const app = await createApp({
      conversationWork: harness.conversationWork,
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
    const authenticate = async (id: string) =>
      await app.request(ACP_TEST_URL, {
        method: "POST",
        headers: {
          "Acp-Connection-Id": connectionId,
          "Content-Type": "application/json",
          Cookie: cookie,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: acp.methods.agent.authenticate,
          params: { methodId: "junior" },
        }),
      });

    await expect(authenticate("first-authenticate")).resolves.toMatchObject({
      status: 202,
    });
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

    await expect(authenticate("second-authenticate")).resolves.toMatchObject({
      status: 202,
    });
    const secondMessage = await readAcpSseMessage(reader, buffer);
    expect(secondMessage).toMatchObject({
      id: "second-authenticate",
      error: {
        code: -32600,
        message: expect.stringContaining(
          "Junior sign-in is already in progress",
        ),
      },
    });
    await expect(
      harness.state.get(
        `junior:acp:v1:connection:${connectionId}:authorization`,
      ),
    ).resolves.toMatchObject({ transactionId });

    await expect(
      completeAcpAuthorization({
        state: harness.state,
        transactionId,
        user: testViewer(harness.actor.email),
        userCode: verificationCodeFromElicitation(params),
      }),
    ).resolves.toBe("completed");
    await expect(readAcpSseMessage(reader, buffer)).resolves.toMatchObject({
      method: acp.methods.client.elicitation.complete,
    });
    await expect(readAcpSseMessage(reader, buffer)).resolves.toMatchObject({
      id: "first-authenticate",
      result: {},
    });
    await reader.cancel();
    reader.releaseLock();
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
    });
    const secondApp = await createApp({
      conversationWork: createIndependentConversationWork(harness),
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
      });
      const secondApp = await createApp({
        conversationWork: createIndependentConversationWork(harness),
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
    });
    const secondApp = await createApp({
      conversationWork: createIndependentConversationWork(harness),
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
      get(target, property) {
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
        const value = readProxyProperty(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as StateAdapter;
    const app = await createApp({
      conversationWork: {
        ...harness.conversationWork,
        state: observedState,
      },
    });
    const secondApp = await createApp({
      conversationWork: createIndependentConversationWork(harness),
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

  it("returns a terminal after failed cleanup and during a later Turn", async () => {
    const harness = await createConversationWorkWebHarness({
      modelStream: streamReplies("First Turn complete."),
    });
    const conversations = createAcpConversations({
      conversationStore: harness.conversationStore,
      eventStore: getConversationEventStore(),
      queue: harness.queue,
      state: harness.state,
    });
    const conversationId = `local:acp:${"1".repeat(32)}`;
    const user = testViewer(harness.actor.email);
    await conversations.create({ conversationId, user });
    const first = await conversations.prompt({
      conversationId,
      idempotencyKey: "first",
      text: "Finish the first Turn.",
      user,
    });
    if (first.status !== "accepted") {
      throw new Error(`First ACP prompt was ${first.status}`);
    }
    await harness.drain();

    const failedAtMs = Date.now();
    await recordConversationExecution({
      conversationId,
      createdAtMs: failedAtMs,
      execution: { status: "failed", updatedAtMs: failedAtMs },
      lastActivityAtMs: failedAtMs,
      state: harness.state,
      updatedAtMs: failedAtMs,
    });
    await expect(
      conversations.readTurn({
        afterCursor: first.afterCursor,
        conversationId,
        messageId: first.messageId,
        turnId: first.turnId,
      }),
    ).resolves.toMatchObject({
      terminal: { outcome: "completed", status: "completed" },
    });

    const second = await conversations.prompt({
      conversationId,
      idempotencyKey: "second",
      text: "Keep the next Turn active.",
      user,
    });
    if (second.status !== "accepted") {
      throw new Error(`Second ACP prompt was ${second.status}`);
    }
    await new ConversationTurnLifecycleService(
      getConversationEventStore(),
    ).start({
      conversationId,
      createdAtMs: Date.now(),
      inputMessageIds: [second.messageId],
      surface: "api",
      turnId: second.turnId,
    });

    await expect(
      conversations.readTurn({
        afterCursor: first.afterCursor,
        conversationId,
        messageId: first.messageId,
        turnId: first.turnId,
      }),
    ).resolves.toMatchObject({
      terminal: { outcome: "completed", status: "completed" },
    });
  });

  it("recovers prompt admission after the first queue send fails", async () => {
    const harness = await createConversationWorkWebHarness({
      modelStream: streamReplies("Recovered queue reply."),
    });
    const app = await createApp({
      conversationWork: harness.conversationWork,
    });
    const secondApp = await createApp({
      conversationWork: createIndependentConversationWork(harness),
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

  it("rejects a prompt before admission when its output stream is full", async () => {
    const harness = await createConversationWorkWebHarness();
    const app = await createApp({
      conversationWork: harness.conversationWork,
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
    const sessionHash = createHash("sha256")
      .update(sessionId)
      .digest("hex")
      .slice(0, 32);
    const streamItemsKey =
      `junior:acp:v1:connection:${connectionId}:stream:` +
      `session:${sessionHash}:items`;
    for (let index = 0; index < 1_024; index += 1) {
      await harness.state.appendToList(streamItemsKey, {
        id: `pending-${index}`,
        output: {
          kind: "message",
          message: { jsonrpc: "2.0", id: index, result: {} },
        },
      });
    }

    const response = await app.request(ACP_TEST_URL, {
      method: "POST",
      headers: {
        "Acp-Connection-Id": connectionId,
        "Acp-Session-Id": sessionId,
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "full-stream-prompt",
        method: acp.methods.agent.session.prompt,
        params: {
          sessionId,
          prompt: [{ type: "text", text: "Do not admit this prompt." }],
        },
      }),
    });

    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toBe(
      "ACP stream has too much undelivered output",
    );
    expect(harness.queue.hasQueuedMessages()).toBe(false);
    await expect(harness.historyTexts(sessionId)).resolves.toEqual([]);
  }, 20_000);
});
