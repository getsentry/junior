import * as acp from "@agentclientprotocol/sdk";
import type { StateAdapter } from "chat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "@/app";
import { getConversationEventStore } from "@/chat/db";
import { createPersonalToken } from "@/personal-tokens/store";
import {
  closeApiTurnWorkFixture,
  createConversationWorkWebHarness,
} from "../fixtures/api-turn";
import {
  ACP_TEST_URL as ACP_URL,
  appFetch,
  connectionCookie,
  createIndependentConversationWork,
  initializeAndAuthenticate,
  initializeRequest,
  mockAcpDashboardConfig,
  withAcpClient,
  withRawAcpConnection,
} from "../fixtures/acp-http";
import { deferred, streamReplies } from "../fixtures/conversation-work";
import { createModelStream } from "../fixtures/model-stream";
import { readProxyProperty } from "../fixtures/proxy-property";

mockAcpDashboardConfig();

describe("remote ACP HTTP", () => {
  afterEach(async () => {
    await closeApiTurnWorkFixture();
  });

  it("mounts the endpoint without extra app config", async () => {
    const harness = await createConversationWorkWebHarness();
    const app = await createApp({
      conversationWork: harness.conversationWork,
    });

    const response = await app.fetch(initializeRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: { protocolVersion: acp.PROTOCOL_VERSION },
    });
  });

  it("stays mounted without dashboard authentication", async () => {
    const harness = await createConversationWorkWebHarness();
    const app = await createApp({
      conversationWork: harness.conversationWork,
      dashboard: { disabled: true },
    });

    const response = await app.fetch(initializeRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: { authMethods: [] },
    });
  });

  it("initializes with isolated cookies and rejects a valid personal token", async () => {
    const harness = await createConversationWorkWebHarness();
    const app = await createApp({
      conversationWork: harness.conversationWork,
    });

    const anonymous = await app.fetch(initializeRequest());
    const token = await createPersonalToken({
      email: harness.actor.email,
      name: "ACP rejected token",
    });
    const bearerRequest = initializeRequest();
    bearerRequest.headers.set("Authorization", `Bearer ${token.token}`);
    const bearer = await app.fetch(bearerRequest);
    const oldConnectionId = anonymous.headers.get("Acp-Connection-Id");
    if (!oldConnectionId) {
      throw new Error("ACP initialize returned no connection");
    }
    const oldCookie = connectionCookie(anonymous);
    const fresh = await app.fetch(initializeRequest("fresh-connection"));
    const freshConnectionId = fresh.headers.get("Acp-Connection-Id");
    if (!freshConnectionId) {
      throw new Error("ACP initialize returned no fresh connection");
    }
    const freshCookie = connectionCookie(fresh);
    const delayedDelete = await app.request(ACP_URL, {
      method: "DELETE",
      headers: {
        "Acp-Connection-Id": oldConnectionId,
        Cookie: oldCookie,
      },
    });
    const freshStream = await app.request(ACP_URL, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        "Acp-Connection-Id": freshConnectionId,
        Cookie: freshCookie,
      },
    });

    expect(anonymous.status).toBe(200);
    expect(bearer.status).toBe(401);
    expect(delayedDelete.status).toBe(202);
    expect(delayedDelete.headers.get("set-cookie")).toBeNull();
    expect(freshStream.status).toBe(200);
    await freshStream.body?.cancel();
  });

  it("validates JSON-RPC envelopes and initialization", async () => {
    const harness = await createConversationWorkWebHarness();
    const app = await createApp({
      conversationWork: harness.conversationWork,
    });
    const nullId = await app.fetch(initializeRequest(null));
    const malformed = await app.request(ACP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", privatePrompt: "sentinel" }),
    });
    const failedInitialize = await app.request(ACP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { clientCapabilities: {} },
      }),
    });
    const initialized = await app.fetch(initializeRequest());
    const connectionId = initialized.headers.get("Acp-Connection-Id");
    if (!connectionId) throw new Error("ACP initialize returned no connection");
    const cookie = connectionCookie(initialized);
    const invalidConnectionId = await app.request(ACP_URL, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        "Acp-Connection-Id": "../../invalid",
      },
    });
    const invalidSessionId = await app.request(ACP_URL, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        "Acp-Connection-Id": connectionId,
        "Acp-Session-Id": "local:acp:invalid",
        Cookie: cookie,
      },
    });

    expect(nullId.status).toBe(200);
    expect(nullId.headers.get("Acp-Connection-Id")).toBeTruthy();
    await expect(nullId.json()).resolves.toMatchObject({
      id: null,
      result: { protocolVersion: acp.PROTOCOL_VERSION },
    });
    expect(malformed.status).toBe(400);
    expect(failedInitialize.status).toBe(200);
    expect(failedInitialize.headers.get("Acp-Connection-Id")).toBeNull();
    await expect(failedInitialize.json()).resolves.toMatchObject({
      error: { code: -32602 },
    });
    expect(invalidConnectionId.status).toBe(400);
    expect(invalidSessionId.status).toBe(400);
  });

  it("requires ACP authentication before session methods", async () => {
    const harness = await createConversationWorkWebHarness();
    const app = await createApp({
      conversationWork: harness.conversationWork,
    });

    const error = await withAcpClient({
      app,
      email: harness.actor.email,
      run: async (context) => {
        const initialized = await context.request(
          acp.methods.agent.initialize,
          {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: { elicitation: { url: {} } },
          },
        );
        expect(initialized.authMethods).toEqual([
          expect.objectContaining({ id: "junior" }),
        ]);
        try {
          await context.request(acp.methods.agent.session.new, {
            cwd: "/client/workspace",
            mcpServers: [],
          });
          return undefined;
        } catch (cause) {
          return cause;
        }
      },
      state: harness.state,
    });

    expect(error).toMatchObject({ code: -32000 });
    expect(harness.queue.hasQueuedMessages()).toBe(false);
  });

  it("runs, reloads, and protects a private Conversation across app instances", async () => {
    const harness = await createConversationWorkWebHarness({
      modelStream: streamReplies("First ACP reply."),
    });
    const app = await createApp({
      conversationWork: harness.conversationWork,
    });
    const secondApp = await createApp({
      conversationWork: createIndependentConversationWork(harness),
    });
    const fetch = appFetch(app, secondApp);
    const firstUpdates: acp.SessionUpdate[] = [];
    let resolveFirstSession!: (sessionId: string) => void;
    const firstSession = new Promise<string>((resolve) => {
      resolveFirstSession = resolve;
    });

    const firstRun = withAcpClient({
      app,
      email: harness.actor.email,
      fetch,
      onUpdate: (update) => firstUpdates.push(update),
      run: async (context) => {
        const initialized = await initializeAndAuthenticate(context);
        expect(initialized).toMatchObject({
          protocolVersion: acp.PROTOCOL_VERSION,
          authMethods: [
            expect.objectContaining({
              id: "junior",
              name: "Sign in to Junior",
            }),
          ],
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
      state: harness.state,
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

    const rawInitialize = await app.fetch(initializeRequest());
    const connectionId = rawInitialize.headers.get("Acp-Connection-Id");
    expect(connectionId).toBeTruthy();
    const cookie = connectionCookie(rawInitialize);
    const stolenConnection = await app.request(ACP_URL, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        "Acp-Connection-Id": connectionId!,
      },
    });
    expect(stolenConnection.status).toBe(401);
    const stolenDelete = await app.request(ACP_URL, {
      method: "DELETE",
      headers: {
        "Acp-Connection-Id": connectionId!,
      },
    });
    expect(stolenDelete.status).toBe(401);
    const ownerDelete = await app.request(ACP_URL, {
      method: "DELETE",
      headers: {
        "Acp-Connection-Id": connectionId!,
        Cookie: `junior_acp_connection=; ${cookie}`,
      },
    });
    expect(ownerDelete.status).toBe(202);
    const deletedConnection = await app.request(ACP_URL, {
      method: "DELETE",
      headers: {
        "Acp-Connection-Id": connectionId!,
        Cookie: cookie,
      },
    });
    expect(deletedConnection.status).toBe(401);

    const crossActorSessionErrors = await withAcpClient({
      app,
      email: "bob@example.com",
      run: async (context) => {
        await initializeAndAuthenticate(context);
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
      state: harness.state,
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
      email: harness.actor.email,
      fetch,
      onUpdate: (update) => secondUpdates.push(update),
      run: async (context) => {
        await initializeAndAuthenticate(context);
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
      state: harness.state,
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

  it("deduplicates exact retries without colliding payloads or id types", async () => {
    const harness = await createConversationWorkWebHarness({
      modelStream: streamReplies("Typed id reply."),
    });
    const app = await createApp({
      conversationWork: harness.conversationWork,
    });

    await withRawAcpConnection({
      app,
      email: harness.actor.email,
      run: async (request) => {
        await request(0, acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { elicitation: { url: {} } },
        });
        await request("authenticate", acp.methods.agent.authenticate, {
          methodId: "junior",
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

        harness.setModelStream(streamReplies("Changed payload reply."));
        const changedPayload = request(2, acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "Reused id, new payload." }],
        });
        await vi.waitFor(() => {
          expect(harness.queue.hasQueuedMessages()).toBe(true);
        });
        await harness.drain();
        await expect(changedPayload).resolves.toEqual({
          stopReason: "end_turn",
        });
        expect(harness.agentRuns).toHaveLength(2);

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
        expect(harness.agentRuns).toHaveLength(3);
        await expect(harness.historyTexts(sessionId)).resolves.toEqual([
          "Numeric request id.",
          "Typed id reply.",
          "Reused id, new payload.",
          "Changed payload reply.",
          "String request id.",
          "Typed id reply.",
        ]);
      },
      state: harness.state,
    });
  }, 20_000);

  it("coordinates an SSE stream across handoff and request abort", async () => {
    const harness = await createConversationWorkWebHarness();
    const app = await createApp({
      conversationWork: harness.conversationWork,
    });
    const secondApp = await createApp({
      conversationWork: createIndependentConversationWork(harness),
    });
    const initialized = await app.fetch(initializeRequest());
    const connectionId = initialized.headers.get("Acp-Connection-Id");
    if (!connectionId) throw new Error("ACP initialize returned no connection");
    const cookie = connectionCookie(initialized);
    const streamRequest = () =>
      new Request(ACP_URL, {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          "Acp-Connection-Id": connectionId,
          Cookie: cookie,
        },
      });

    const first = await app.fetch(streamRequest());
    const overlapping = await secondApp.fetch(streamRequest());

    expect(first.status).toBe(200);
    expect(overlapping.status).toBe(409);
    await first.body?.cancel();

    const handedOff = await secondApp.fetch(streamRequest());
    expect(handedOff.status).toBe(200);
    await handedOff.body?.cancel();

    const requestAbort = new AbortController();
    const aborted = await app.fetch(
      new Request(streamRequest(), { signal: requestAbort.signal }),
    );
    expect(aborted.status).toBe(200);
    const reader = aborted.body?.getReader();
    if (!reader) throw new Error("ACP GET returned no stream body");

    requestAbort.abort();

    await expect(reader.closed).resolves.toBeUndefined();
    reader.releaseLock();
  });

  it("terminates an SSE stream after it loses its shared lease", async () => {
    const harness = await createConversationWorkWebHarness();
    const state = new Proxy(harness.state, {
      get(target, property) {
        if (property === "extendLock") {
          return async (
            lock: Parameters<StateAdapter["extendLock"]>[0],
            ttlMs: number,
          ) =>
            lock.threadId.endsWith(":subscriber")
              ? false
              : await target.extendLock(lock, ttlMs);
        }
        const value = readProxyProperty(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const app = await createApp({
      conversationWork: createIndependentConversationWork(harness, state),
    });
    const initialized = await app.fetch(initializeRequest());
    const connectionId = initialized.headers.get("Acp-Connection-Id");
    if (!connectionId) throw new Error("ACP initialize returned no connection");
    const cookie = connectionCookie(initialized);
    const stream = await app.request(ACP_URL, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        "Acp-Connection-Id": connectionId,
        Cookie: cookie,
      },
    });
    const reader = stream.body?.getReader();
    if (!reader) throw new Error("ACP GET returned no stream body");

    const accepted = await app.request(ACP_URL, {
      method: "POST",
      headers: {
        "Acp-Connection-Id": connectionId,
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "unsupported/test",
        params: {},
      }),
    });

    expect(accepted.status).toBe(202);
    await expect(reader.read()).rejects.toThrow("ACP SSE stream lease expired");
    reader.releaseLock();
  });

  it("finishes durable work after the ACP connection closes", async () => {
    const harness = await createConversationWorkWebHarness({
      modelStream: streamReplies("Completed after disconnect."),
    });
    const app = await createApp({
      conversationWork: harness.conversationWork,
    });
    const promptAccepted = deferred();
    const sessionStreamOpened = deferred<Response>();
    let connectionId: string | undefined;
    let cookie: string | undefined;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init as RequestInit);
      cookie ??= request.headers.get("cookie") ?? undefined;
      const isSessionStream =
        request.method === "GET" && request.headers.has("Acp-Session-Id");
      let isPrompt = false;
      if (request.method === "POST") {
        const body: unknown = await request.clone().json();
        isPrompt =
          typeof body === "object" &&
          body !== null &&
          "method" in body &&
          body.method === acp.methods.agent.session.prompt;
      }
      const response = await app.fetch(
        isSessionStream
          ? new Request(request, { signal: new AbortController().signal })
          : request,
      );
      connectionId ??= response.headers.get("Acp-Connection-Id") ?? undefined;
      if (isPrompt && response.status === 202) promptAccepted.resolve();
      if (isSessionStream && response.status === 200) {
        sessionStreamOpened.resolve(response);
        return response.clone();
      }
      return response;
    };
    let resolveSession!: (sessionId: string) => void;
    const session = new Promise<string>((resolve) => {
      resolveSession = resolve;
    });
    const connected = withAcpClient({
      app,
      email: harness.actor.email,
      fetch,
      run: async (context) => {
        await initializeAndAuthenticate(context);
        const created = await context.request(acp.methods.agent.session.new, {
          cwd: "/client/workspace",
          mcpServers: [],
        });
        resolveSession(created.sessionId);
        return await context.request(acp.methods.agent.session.prompt, {
          sessionId: created.sessionId,
          prompt: [{ type: "text", text: "Keep running." }],
        });
      },
      state: harness.state,
    });
    const connectionClosed = connected.catch(() => undefined);

    const sessionId = await session;
    await vi.waitFor(() => {
      expect(harness.queue.hasQueuedMessages()).toBe(true);
    });
    await promptAccepted.promise;
    const sessionStream = await sessionStreamOpened.promise;
    if (!sessionStream.body)
      throw new Error("ACP session SSE returned no body");
    const sessionReader = sessionStream.body.getReader();
    const sessionClosed = (async () => {
      while (!(await sessionReader.read()).done) {
        // Drain all session output until the server ends the stream.
      }
    })();
    if (!connectionId) throw new Error("ACP initialize returned no connection");
    if (!cookie) throw new Error("ACP client sent no connection cookie");
    const deleted = await app.request(ACP_URL, {
      method: "DELETE",
      headers: {
        "Acp-Connection-Id": connectionId,
        Cookie: cookie,
      },
    });
    expect(deleted.status).toBe(202);
    await connectionClosed;
    await expect(sessionClosed).resolves.toBeUndefined();
    sessionReader.releaseLock();
    await harness.drain();

    const replayed: acp.SessionUpdate[] = [];
    await withAcpClient({
      app,
      email: harness.actor.email,
      onUpdate: (update) => replayed.push(update),
      run: async (context) => {
        await initializeAndAuthenticate(context);
        await context.request(acp.methods.agent.session.load, {
          sessionId,
          cwd: "/client/workspace",
          mcpServers: [],
        });
      },
      state: harness.state,
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

  it("cancels the active Turn and accepts a later prompt", async () => {
    const modelStarted = deferred();
    const releaseModel = deferred();
    const harness = await createConversationWorkWebHarness({
      modelStream: createModelStream([
        {
          type: "text",
          text: "This reply must not be stored.",
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
    let cancelActiveTurn: (() => Promise<void>) | undefined;

    const cancelledRun = withAcpClient({
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
          prompt: [{ type: "text", text: "Cancel this Turn." }],
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
    if (!cancelActiveTurn) {
      throw new Error("ACP cancellation handler was not ready");
    }
    await cancelActiveTurn();
    await vi.waitFor(() => {
      expect(harness.agentRuns[0]?.signal?.aborted).toBe(true);
    });
    releaseModel.resolve();
    await draining;

    await expect(cancelledRun).resolves.toEqual({ stopReason: "cancelled" });
    expect(harness.agentRuns).toHaveLength(1);
    await expect(harness.historyTexts(sessionId)).resolves.toEqual([
      "Cancel this Turn.",
    ]);
    const terminalEvents = await getConversationEventStore().query(sessionId, {
      limit: 50,
      types: ["turn_completed", "turn_failed"],
    });
    expect(terminalEvents.events).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          outcome: "cancelled",
          type: "turn_completed",
        }),
      }),
    ]);

    harness.setModelStream(streamReplies("Reply after cancellation."));
    const followUpStarted = deferred();
    const followUp = withAcpClient({
      app,
      email: harness.actor.email,
      run: async (context) => {
        await initializeAndAuthenticate(context);
        await context.request(acp.methods.agent.session.load, {
          sessionId,
          cwd: "/client/workspace",
          mcpServers: [],
        });
        followUpStarted.resolve();
        return await context.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "Continue after cancellation." }],
        });
      },
      state: harness.state,
    });

    await followUpStarted.promise;
    await vi.waitFor(() => {
      expect(harness.queue.hasQueuedMessages()).toBe(true);
    });
    await harness.drain();
    await expect(followUp).resolves.toEqual({ stopReason: "end_turn" });
    expect(harness.agentRuns).toHaveLength(2);
    await expect(harness.historyTexts(sessionId)).resolves.toEqual([
      "Cancel this Turn.",
      "Continue after cancellation.",
      "Reply after cancellation.",
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
    });
    let sessionId: string | undefined;
    const failed = withAcpClient({
      app,
      email: harness.actor.email,
      run: async (context) => {
        await initializeAndAuthenticate(context);
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
      state: harness.state,
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
    });
    const errors = await withAcpClient({
      app,
      email: harness.actor.email,
      run: async (context) => {
        await initializeAndAuthenticate(context);
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
          [
            {
              type: "text" as const,
              text: "Unknown fields are not accepted.",
              privatePrompt: "sentinel",
            },
          ],
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
      state: harness.state,
    });

    expect(errors.mcpError).toMatchObject({ code: -32602 });
    expect(errors.promptErrors).toHaveLength(5);
    expect(errors.promptErrors).toEqual([
      expect.objectContaining({ code: -32602 }),
      expect.objectContaining({ code: -32602 }),
      expect.objectContaining({ code: -32602 }),
      expect.objectContaining({ code: -32602 }),
      expect.objectContaining({ code: -32602 }),
    ]);
    expect(harness.queue.hasQueuedMessages()).toBe(false);
  });
});
