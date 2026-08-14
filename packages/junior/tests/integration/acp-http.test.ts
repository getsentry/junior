import * as acp from "@agentclientprotocol/sdk";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import type { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "@/app";
import { getConversationEventStore } from "@/chat/db";
import { createPersonalToken } from "@/personal-tokens/store";
import {
  closeApiTurnWorkFixture,
  createConversationWorkWebHarness,
} from "../fixtures/api-turn";
import { streamReplies } from "../fixtures/conversation-work";
import { createModelStream } from "../fixtures/model-stream";

const ACP_URL = "http://junior.test/api/acp";

function appFetch(app: Hono): typeof globalThis.fetch {
  return async (input, init) =>
    await app.fetch(new Request(input, init as RequestInit));
}

function initializeRequest(token?: string): Request {
  return new Request(ACP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      },
    }),
  });
}

async function withAcpClient<T>(args: {
  app: Hono;
  onUpdate?: (update: acp.SessionUpdate) => void;
  run: (context: acp.ClientContext) => Promise<T>;
  token: string;
}): Promise<T> {
  const stream = createHttpStream(ACP_URL, {
    fetch: appFetch(args.app),
    headers: { Authorization: `Bearer ${args.token}` },
  });
  try {
    return await acp
      .client({ name: "junior-acp-test" })
      .onNotification(acp.methods.client.session.update, (context) => {
        args.onUpdate?.(context.params.update);
      })
      .connectWith(stream, args.run);
  } finally {
    await stream.writable.close().catch(() => undefined);
  }
}

/** Drive explicit JSON-RPC ids through the official HTTP transport. */
async function withRawAcpConnection<T>(args: {
  app: Hono;
  run: (
    request: (
      id: acp.JsonRpcId,
      method: string,
      params: unknown,
    ) => Promise<unknown>,
  ) => Promise<T>;
  token: string;
}): Promise<T> {
  const stream = createHttpStream(ACP_URL, {
    fetch: appFetch(args.app),
    headers: { Authorization: `Bearer ${args.token}` },
  });
  const reader = stream.readable.getReader();
  const writer = stream.writable.getWriter();
  const request = async (
    id: acp.JsonRpcId,
    method: string,
    params: unknown,
  ): Promise<unknown> => {
    await writer.write({ jsonrpc: "2.0", id, method, params });
    while (true) {
      const next = await reader.read();
      if (next.done) {
        throw new Error("ACP stream closed before the response arrived");
      }
      if (!("id" in next.value) || next.value.id !== id) continue;
      if ("method" in next.value) continue;
      if ("error" in next.value) {
        throw new Error(
          `ACP request failed: ${next.value.error.code} ${next.value.error.message}`,
        );
      }
      return next.value.result;
    }
  };
  try {
    return await args.run(request);
  } finally {
    await writer.close().catch(() => undefined);
    writer.releaseLock();
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

describe("remote ACP HTTP", () => {
  afterEach(async () => {
    await closeApiTurnWorkFixture();
  });

  it("does not mount the endpoint without the experimental flag", async () => {
    const harness = await createConversationWorkWebHarness();
    const app = await createApp({
      conversationWork: harness.conversationWork,
      experimental: { subagents: true },
    });

    const response = await app.fetch(initializeRequest());

    expect(response.status).toBe(404);
  });

  it("requires a valid personal bearer token before ACP dispatch", async () => {
    const harness = await createConversationWorkWebHarness();
    const app = await createApp({
      conversationWork: harness.conversationWork,
      experimental: { acp: true, subagents: true },
    });

    const missing = await app.fetch(initializeRequest());
    const invalid = await app.fetch(initializeRequest("jr_pat_invalid"));

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
  });

  it("rejects unsafe envelopes and failed initialization", async () => {
    const harness = await createConversationWorkWebHarness();
    const app = await createApp({
      conversationWork: harness.conversationWork,
      experimental: { acp: true, subagents: true },
    });
    const token = await createPersonalToken({
      email: harness.actor.email,
      name: "ACP envelope validation",
    });
    const malformed = await app.request(ACP_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", privatePrompt: "sentinel" }),
    });
    const wrongVersion = await app.request(ACP_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "1.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
    });
    const nonFiniteId = await app.request(ACP_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.token}`,
        "Content-Type": "application/json",
      },
      body: '{"jsonrpc":"2.0","id":1e400,"method":"session/new"}',
    });
    const failedInitialize = await app.request(ACP_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { clientCapabilities: {} },
      }),
    });

    expect(malformed.status).toBe(400);
    expect(wrongVersion.status).toBe(400);
    expect(nonFiniteId.status).toBe(400);
    expect(failedInitialize.status).toBe(200);
    expect(failedInitialize.headers.get("Acp-Connection-Id")).toBeNull();
    await expect(failedInitialize.json()).resolves.toMatchObject({
      error: { code: -32602 },
    });
  });

  it("runs, reloads, and protects a private Conversation through the official client", async () => {
    const harness = await createConversationWorkWebHarness({
      modelStream: streamReplies("First ACP reply."),
    });
    const app = await createApp({
      conversationWork: harness.conversationWork,
      experimental: { acp: true, subagents: true },
    });
    const ownerToken = await createPersonalToken({
      email: harness.actor.email,
      name: "ACP owner",
    });
    const otherToken = await createPersonalToken({
      email: "bob@example.com",
      name: "ACP other actor",
    });
    const firstUpdates: acp.SessionUpdate[] = [];
    let resolveFirstSession!: (sessionId: string) => void;
    const firstSession = new Promise<string>((resolve) => {
      resolveFirstSession = resolve;
    });

    const firstRun = withAcpClient({
      app,
      token: ownerToken.token,
      onUpdate: (update) => firstUpdates.push(update),
      run: async (context) => {
        const initialized = await context.request(
          acp.methods.agent.initialize,
          {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
          },
        );
        expect(initialized).toMatchObject({
          protocolVersion: acp.PROTOCOL_VERSION,
          authMethods: [],
        });
        expect(initialized.agentCapabilities).toEqual({
          loadSession: true,
          promptCapabilities: {
            audio: false,
            embeddedContext: false,
            image: false,
          },
        });
        const session = await context.request(acp.methods.agent.session.new, {
          cwd: "/client/workspace",
          mcpServers: [],
        });
        resolveFirstSession(session.sessionId);
        const result = await context.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [
            { type: "text", text: "First" },
            { type: "text", text: "ACP prompt." },
          ],
        });
        return { result, sessionId: session.sessionId };
      },
    });

    const sessionId = await firstSession;
    await expect(
      harness.conversationStore.get({ conversationId: sessionId }),
    ).resolves.toMatchObject({
      conversationId: sessionId,
      source: "web",
      visibility: "private",
    });
    await vi.waitFor(() => {
      expect(harness.queue.hasQueuedMessages()).toBe(true);
    });
    await harness.drain();
    const first = await firstRun;

    expect(first.result).toEqual({ stopReason: "end_turn" });
    expect(first.sessionId).toBe(sessionId);
    expect(firstUpdates).toEqual([
      expect.objectContaining({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "First ACP reply." },
      }),
    ]);
    expect(harness.agentRuns).toHaveLength(1);
    expect(harness.agentRuns[0]).toMatchObject({
      publishExternally: false,
      source: { platform: "web", visibility: "private" },
    });
    await expect(harness.historyTexts(sessionId)).resolves.toEqual([
      "First\nACP prompt.",
      "First ACP reply.",
    ]);

    const rawInitialize = await app.fetch(initializeRequest(ownerToken.token));
    const connectionId = rawInitialize.headers.get("Acp-Connection-Id");
    expect(connectionId).toBeTruthy();
    const crossActorConnection = await app.request(ACP_URL, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${otherToken.token}`,
        "Acp-Connection-Id": connectionId!,
      },
    });
    expect(crossActorConnection.status).toBe(404);
    await app.request(ACP_URL, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${ownerToken.token}`,
        "Acp-Connection-Id": connectionId!,
      },
    });

    const crossActorSessionErrors = await withAcpClient({
      app,
      token: otherToken.token,
      run: async (context) => {
        await context.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        let loadError: unknown;
        let promptError: unknown;
        try {
          await context.request(acp.methods.agent.session.load, {
            sessionId,
            cwd: "/client/workspace",
            mcpServers: [],
          });
        } catch (error) {
          loadError = error;
        }
        try {
          await context.request(acp.methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: "text", text: "Cross-Actor prompt." }],
          });
        } catch (error) {
          promptError = error;
        }
        return { loadError, promptError };
      },
    });
    expect(crossActorSessionErrors).toEqual({
      loadError: expect.objectContaining({ code: -32002 }),
      promptError: expect.objectContaining({ code: -32002 }),
    });
    expect(harness.queue.hasQueuedMessages()).toBe(false);
    await expect(harness.historyTexts(sessionId)).resolves.toEqual([
      "First\nACP prompt.",
      "First ACP reply.",
    ]);

    harness.setModelStream(streamReplies("Second ACP reply."));
    const secondUpdates: acp.SessionUpdate[] = [];
    let resolveSecondPrompt!: () => void;
    const secondPromptStarted = new Promise<void>((resolve) => {
      resolveSecondPrompt = resolve;
    });
    const secondRun = withAcpClient({
      app,
      token: ownerToken.token,
      onUpdate: (update) => secondUpdates.push(update),
      run: async (context) => {
        await context.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        await context.request(acp.methods.agent.session.load, {
          sessionId,
          cwd: "/different/client/workspace",
          mcpServers: [],
        });
        resolveSecondPrompt();
        return await context.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "Follow up." }],
        });
      },
    });

    await secondPromptStarted;
    await vi.waitFor(() => {
      expect(harness.queue.hasQueuedMessages()).toBe(true);
    });
    await harness.drain();
    await expect(secondRun).resolves.toEqual({ stopReason: "end_turn" });
    expect(secondUpdates).toEqual([
      expect.objectContaining({
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "First\nACP prompt." },
      }),
      expect.objectContaining({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "First ACP reply." },
      }),
      expect.objectContaining({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Second ACP reply." },
      }),
    ]);
    await expect(harness.historyTexts(sessionId)).resolves.toEqual([
      "First\nACP prompt.",
      "First ACP reply.",
      "Follow up.",
      "Second ACP reply.",
    ]);
  }, 20_000);

  it("deduplicates repeated request ids without colliding id types", async () => {
    const harness = await createConversationWorkWebHarness({
      modelStream: streamReplies("Typed id reply."),
    });
    const app = await createApp({
      conversationWork: harness.conversationWork,
      experimental: { acp: true, subagents: true },
    });
    const token = await createPersonalToken({
      email: harness.actor.email,
      name: "ACP idempotency",
    });

    await withRawAcpConnection({
      app,
      token: token.token,
      run: async (request) => {
        await request(0, acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const created = await request(1, acp.methods.agent.session.new, {
          cwd: "/client/workspace",
          mcpServers: [],
        });
        if (
          typeof created !== "object" ||
          created === null ||
          !("sessionId" in created) ||
          typeof created.sessionId !== "string"
        ) {
          throw new Error("ACP session/new returned no session id");
        }
        const sessionId = created.sessionId;
        const first = request(2, acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "Numeric request id." }],
        });
        await vi.waitFor(() => {
          expect(harness.queue.hasQueuedMessages()).toBe(true);
        });
        await harness.drain();
        await expect(first).resolves.toEqual({ stopReason: "end_turn" });

        await expect(
          request(2, acp.methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: "text", text: "Numeric request id." }],
          }),
        ).resolves.toEqual({ stopReason: "end_turn" });
        expect(harness.queue.hasQueuedMessages()).toBe(false);
        expect(harness.agentRuns).toHaveLength(1);

        harness.setModelStream(streamReplies("Typed id reply."));
        const typed = request("2", acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "String request id." }],
        });
        const typedResult = typed.then((result) => {
          expect(result).toEqual({ stopReason: "end_turn" });
        });
        await vi.waitFor(() => {
          expect(harness.queue.hasQueuedMessages()).toBe(true);
        });
        await harness.drain();
        await typedResult;
        expect(harness.agentRuns).toHaveLength(2);
        await expect(harness.historyTexts(sessionId)).resolves.toEqual([
          "Numeric request id.",
          "Typed id reply.",
          "String request id.",
          "Typed id reply.",
        ]);
      },
    });
  }, 20_000);

  it("finishes durable work after the ACP connection closes", async () => {
    const harness = await createConversationWorkWebHarness({
      modelStream: streamReplies("Completed after disconnect."),
    });
    const app = await createApp({
      conversationWork: harness.conversationWork,
      experimental: { acp: true, subagents: true },
    });
    const token = await createPersonalToken({
      email: harness.actor.email,
      name: "ACP disconnect",
    });
    const stream = createHttpStream(ACP_URL, {
      fetch: appFetch(app),
      headers: { Authorization: `Bearer ${token.token}` },
    });
    let resolveSession!: (sessionId: string) => void;
    const session = new Promise<string>((resolve) => {
      resolveSession = resolve;
    });
    const connected = acp
      .client({ name: "junior-acp-disconnect-test" })
      .connectWith(stream, async (context) => {
        await context.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const created = await context.request(acp.methods.agent.session.new, {
          cwd: "/client/workspace",
          mcpServers: [],
        });
        resolveSession(created.sessionId);
        return await context.request(acp.methods.agent.session.prompt, {
          sessionId: created.sessionId,
          prompt: [{ type: "text", text: "Keep running." }],
        });
      });
    const connectionClosed = connected.catch(() => undefined);

    const sessionId = await session;
    await vi.waitFor(() => {
      expect(harness.queue.hasQueuedMessages()).toBe(true);
    });
    await stream.writable.close();
    await connectionClosed;
    await harness.drain();

    const replayed: acp.SessionUpdate[] = [];
    await withAcpClient({
      app,
      token: token.token,
      onUpdate: (update) => replayed.push(update),
      run: async (context) => {
        await context.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        await context.request(acp.methods.agent.session.load, {
          sessionId,
          cwd: "/client/workspace",
          mcpServers: [],
        });
      },
    });

    await expect(harness.historyTexts(sessionId)).resolves.toEqual([
      "Keep running.",
      "Completed after disconnect.",
    ]);
    expect(replayed).toEqual([
      expect.objectContaining({
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "Keep running." },
      }),
      expect.objectContaining({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Completed after disconnect." },
      }),
    ]);
  }, 20_000);

  it("maps one durable failed Turn to a protocol error", async () => {
    const harness = await createConversationWorkWebHarness({
      modelStream: createModelStream([
        { type: "error", errorMessage: "model unavailable" },
      ]),
    });
    const app = await createApp({
      conversationWork: harness.conversationWork,
      experimental: { acp: true, subagents: true },
    });
    const token = await createPersonalToken({
      email: harness.actor.email,
      name: "ACP failed Turn",
    });
    let sessionId: string | undefined;
    const failed = withAcpClient({
      app,
      token: token.token,
      run: async (context) => {
        await context.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const session = await context.request(acp.methods.agent.session.new, {
          cwd: "/client/workspace",
          mcpServers: [],
        });
        sessionId = session.sessionId;
        return await context.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "Fail this Turn." }],
        });
      },
    });
    const failedResult = failed.then(
      () => {
        throw new Error("Expected the ACP prompt to fail");
      },
      (error: unknown) => {
        expect(error).toMatchObject({
          code: -32603,
          data: { failureCode: "model_execution_failed" },
        });
      },
    );

    await vi.waitFor(() => {
      expect(harness.queue.hasQueuedMessages()).toBe(true);
    });
    await harness.drain();
    await failedResult;
    if (!sessionId) throw new Error("ACP session was not created");
    const events = await getConversationEventStore().query(sessionId, {
      limit: 50,
      types: ["turn_failed"],
    });
    expect(events.events).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          failureCode: "model_execution_failed",
          type: "turn_failed",
        }),
      }),
    ]);
    expect(harness.agentRuns).toHaveLength(1);
  }, 20_000);

  it("rejects unsupported MCP and prompt content at the protocol boundary", async () => {
    const harness = await createConversationWorkWebHarness();
    const app = await createApp({
      conversationWork: harness.conversationWork,
      experimental: { acp: true, subagents: true },
    });
    const token = await createPersonalToken({
      email: harness.actor.email,
      name: "ACP validation",
    });

    const errors = await withAcpClient({
      app,
      token: token.token,
      run: async (context) => {
        await context.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        let mcpError: unknown;
        try {
          await context.request(acp.methods.agent.session.new, {
            cwd: "/client/workspace",
            mcpServers: [
              { command: "example", args: [], env: [], name: "example" },
            ],
          });
        } catch (error) {
          mcpError = error;
        }
        const session = await context.request(acp.methods.agent.session.new, {
          cwd: "/client/workspace",
          mcpServers: [],
        });
        const promptErrors: unknown[] = [];
        for (const prompt of [
          [
            {
              type: "resource_link" as const,
              name: "client file",
              uri: "file:///client/workspace/file.ts",
            },
          ],
          [
            {
              type: "image" as const,
              data: "AA==",
              mimeType: "image/png",
            },
          ],
          [{ type: "text" as const, text: " " }],
          [{ type: "text" as const, text: "x".repeat(32_001) }],
        ]) {
          try {
            await context.request(acp.methods.agent.session.prompt, {
              sessionId: session.sessionId,
              prompt,
            });
          } catch (error) {
            promptErrors.push(error);
          }
        }
        return { mcpError, promptErrors };
      },
    });

    expect(errors.mcpError).toMatchObject({ code: -32602 });
    expect(errors.promptErrors).toHaveLength(4);
    expect(errors.promptErrors).toEqual([
      expect.objectContaining({ code: -32602 }),
      expect.objectContaining({ code: -32602 }),
      expect.objectContaining({ code: -32602 }),
      expect.objectContaining({ code: -32602 }),
    ]);
    expect(harness.queue.hasQueuedMessages()).toBe(false);
  });
});
