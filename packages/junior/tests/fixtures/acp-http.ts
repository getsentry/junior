import * as acp from "@agentclientprotocol/sdk";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import type { StateAdapter } from "chat";
import type { Hono } from "hono";
import { vi } from "vitest";
import { completeAcpAuthorization } from "@/api/acp/auth";
import { createConversationWork } from "@/chat/app/conversation-work";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import type { ConversationWorkWebHarness } from "./api-turn";
import { createSlackAdapterFixture } from "./conversation-work";

export const ACP_TEST_URL = "http://junior.test/api/acp";

/** Supply dashboard browser authentication for ACP integration tests. */
export function mockAcpDashboardConfig(): void {
  vi.doMock("#junior/config", () => ({
    createDashboardApp: () => ({
      fetch: () => new Response("Not Found", { status: 404 }),
    }),
    dashboard: { authRequired: false, baseURL: "http://junior.test" },
    functionMaxDurationSeconds: undefined,
    pluginSet: undefined,
    plugins: undefined,
    pluginRuntimeRegistrations: [],
  }));
}

/** Read the browser verification code shown by an ACP URL elicitation. */
export function verificationCodeFromElicitation(
  params: acp.CreateElicitationRequest,
): string {
  const code = params.message?.match(/\b[0-9A-F]{4}(?:-[0-9A-F]{4}){2}\b/)?.[0];
  if (!code) throw new Error("ACP authorization elicitation has no code");
  return code;
}

/** Read the ACP connection cookie from an initialize response. */
export function connectionCookie(response: Response): string {
  const value = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!value) throw new Error("ACP initialize returned no connection cookie");
  return value;
}

/** Read the next JSON-RPC message from a raw ACP event stream. */
export async function readAcpSseMessage(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buffer: { value: string },
): Promise<acp.AnyMessage> {
  const decoder = new TextDecoder();
  while (true) {
    const boundary = buffer.value.indexOf("\n\n");
    if (boundary >= 0) {
      const event = buffer.value.slice(0, boundary);
      buffer.value = buffer.value.slice(boundary + 2);
      const data = event
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("\n");
      if (data) return JSON.parse(data) as acp.AnyMessage;
      continue;
    }
    const chunk = await reader.read();
    if (chunk.done) throw new Error("ACP SSE closed before authentication");
    buffer.value += decoder.decode(chunk.value, { stream: true });
  }
}

/** Route successive ACP transport requests across the supplied app instances. */
export function appFetch(...apps: Hono[]): typeof globalThis.fetch {
  let nextApp = 0;
  return async (input, init) => {
    const app = apps[nextApp % apps.length];
    nextApp += 1;
    if (!app) throw new Error("ACP test fetch requires an app");
    return await app.fetch(new Request(input, init as RequestInit));
  };
}

/** Build another app-scoped Conversation worker over the shared test stores. */
export function createIndependentConversationWork(
  harness: ConversationWorkWebHarness,
  state: StateAdapter = harness.state,
) {
  return createConversationWork({
    agentRunner: harness.agentRunner,
    conversationStore: harness.conversationStore,
    getSlackAdapter: () => createSlackAdapterFixture(),
    queue: harness.queue,
    services: { replyExecutor: { agentRunner: harness.agentRunner } },
    state,
  });
}

/** Build one ACP initialize request with browser authorization support. */
export function initializeRequest(id: acp.JsonRpcId = 1): Request {
  return new Request(ACP_TEST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        _meta: { source: "integration-test" },
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { elicitation: { url: {} } },
      },
    }),
  });
}

async function authorizeFromElicitation(args: {
  email: string;
  params: acp.CreateElicitationRequest;
  state: StateAdapter;
}): Promise<acp.CreateElicitationResponse> {
  if (args.params.mode !== "url" || typeof args.params.url !== "string") {
    throw new Error("ACP test client requires URL elicitation");
  }
  const transactionId = new URL(args.params.url).pathname
    .split("/")
    .filter(Boolean)
    .at(-1);
  if (!transactionId) {
    throw new Error("ACP authorization URL has no transaction id");
  }
  const user = await resolveViewerUser(args.email);
  if (!user) throw new Error("ACP test user could not be resolved");
  const completed = await completeAcpAuthorization({
    state: args.state,
    transactionId,
    user,
    userCode: verificationCodeFromElicitation(args.params),
  });
  if (completed !== "completed") {
    throw new Error(`ACP test authorization ${completed}`);
  }
  return { action: "accept" };
}

/** Open and authenticate a raw ACP connection for HTTP boundary assertions. */
export async function openAuthenticatedAcpConnection(args: {
  app: Hono;
  email: string;
  state: StateAdapter;
}): Promise<{ connectionId: string; cookie: string }> {
  const initialized = await args.app.fetch(initializeRequest());
  const connectionId = initialized.headers.get("Acp-Connection-Id");
  if (!connectionId) throw new Error("ACP initialize returned no connection");
  const cookie = connectionCookie(initialized);
  const stream = await args.app.fetch(
    new Request(ACP_TEST_URL, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        "Acp-Connection-Id": connectionId,
        Cookie: cookie,
      },
    }),
  );
  const reader = stream.body?.getReader();
  if (!reader) throw new Error("ACP connection stream returned no body");
  const requestId = "fixture-authenticate";
  const accepted = await args.app.fetch(
    new Request(ACP_TEST_URL, {
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
  if (accepted.status !== 202) {
    throw new Error(`ACP authenticate returned HTTP ${accepted.status}`);
  }

  const buffer = { value: "" };
  while (true) {
    const message = await readAcpSseMessage(reader, buffer);
    if (
      "method" in message &&
      message.method === acp.methods.client.elicitation.create &&
      "id" in message &&
      message.id !== undefined
    ) {
      const result = await authorizeFromElicitation({
        email: args.email,
        params: message.params as acp.CreateElicitationRequest,
        state: args.state,
      });
      await args.app.fetch(
        new Request(ACP_TEST_URL, {
          method: "POST",
          headers: {
            "Acp-Connection-Id": connectionId,
            "Content-Type": "application/json",
            Cookie: cookie,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result,
          }),
        }),
      );
      continue;
    }
    if ("id" in message && message.id === requestId && !("method" in message)) {
      if ("error" in message) {
        throw new Error(`ACP authentication failed: ${message.error.message}`);
      }
      break;
    }
  }
  await reader.cancel();
  reader.releaseLock();
  return { connectionId, cookie };
}

/** Initialize and complete the ACP-advertised browser authentication method. */
export async function initializeAndAuthenticate(
  context: acp.ClientContext,
): Promise<acp.InitializeResponse> {
  const initialized = await context.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: { elicitation: { url: {} } },
  });
  await context.request(acp.methods.agent.authenticate, {
    methodId: "junior",
  });
  return initialized;
}

/** Run one callback through the official ACP Streamable HTTP client. */
export async function withAcpClient<T>(args: {
  app: Hono;
  email: string;
  fetch?: typeof globalThis.fetch;
  onUpdate?: (update: acp.SessionUpdate) => void;
  run: (context: acp.ClientContext) => Promise<T>;
  state: StateAdapter;
}): Promise<T> {
  const stream = createHttpStream(ACP_TEST_URL, {
    fetch: args.fetch ?? appFetch(args.app),
  });
  try {
    return await acp
      .client({ name: "junior-acp-test" })
      .onRequest(
        acp.methods.client.elicitation.create,
        async (context) =>
          await authorizeFromElicitation({
            email: args.email,
            params: context.params,
            state: args.state,
          }),
      )
      .onNotification(acp.methods.client.session.update, (context) => {
        args.onUpdate?.(context.params.update);
      })
      .connectWith(stream, args.run);
  } finally {
    await stream.writable.close().catch(() => undefined);
  }
}

/** Drive explicit JSON-RPC ids through the official HTTP transport. */
export async function withRawAcpConnection<T>(args: {
  app: Hono;
  email: string;
  run: (
    request: (
      id: acp.JsonRpcId,
      method: string,
      params: unknown,
    ) => Promise<unknown>,
  ) => Promise<T>;
  state: StateAdapter;
}): Promise<T> {
  const stream = createHttpStream(ACP_TEST_URL, {
    fetch: appFetch(args.app),
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
      if (
        "method" in next.value &&
        next.value.method === acp.methods.client.elicitation.create &&
        "id" in next.value &&
        next.value.id !== undefined
      ) {
        const result = await authorizeFromElicitation({
          email: args.email,
          params: next.value.params as acp.CreateElicitationRequest,
          state: args.state,
        });
        await writer.write({
          jsonrpc: "2.0",
          id: next.value.id,
          result,
        });
        continue;
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
