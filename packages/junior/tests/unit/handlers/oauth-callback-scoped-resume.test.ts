import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  BASE_URL,
  GITHUB_OAUTH_CONFIG,
  lookupSlackActorIdentityMock,
  resumeSlackTurnMock,
  waitUntilCallbacks,
} = vi.hoisted(() => ({
  BASE_URL: "https://example.com",
  GITHUB_OAUTH_CONFIG: {
    clientIdEnv: "GITHUB_APP_CLIENT_ID",
    clientSecretEnv: "GITHUB_APP_CLIENT_SECRET",
    authorizeEndpoint: "https://github.com/login/oauth/authorize",
    tokenEndpoint: "https://github.com/login/oauth/access_token",
    treatEmptyScopeAsUnreported: true,
    callbackPath: "/api/oauth/callback/github",
  },
  lookupSlackActorIdentityMock: vi.fn(),
  resumeSlackTurnMock: vi.fn(),
  waitUntilCallbacks: [] as Array<() => Promise<unknown> | void>,
}));

vi.mock("@/chat/plugins/registry", () => ({
  getPluginOAuthConfig: (provider: string) =>
    provider === "github" ? GITHUB_OAUTH_CONFIG : undefined,
  isPluginProvider: (provider: string) => provider === "github",
  getPluginCapabilityProviders: () => [],
  isPluginCapability: () => false,
  isPluginConfigKey: () => false,
  getPluginProviders: () => [],
  getPluginSkillRoots: () => [],
  createPluginBroker: () => {
    throw new Error("not implemented in test");
  },
}));

vi.mock("@/chat/config", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/chat/config")>();
  const memoryConfig = original.readChatConfig({
    ...process.env,
    JUNIOR_STATE_ADAPTER: "memory",
  });
  return {
    ...original,
    botConfig: {
      ...memoryConfig.bot,
      userName: "junior",
    },
    getChatConfig: () => memoryConfig,
  };
});

vi.mock("@/chat/runtime/slack-resume", () => {
  class ResumeTurnBusyError extends Error {}
  return {
    ResumeTurnBusyError,
    resumeAuthorizedRequest: vi.fn(),
    resumeSlackTurn: resumeSlackTurnMock,
  };
});

vi.mock("@/chat/slack/user", () => ({
  lookupSlackActorIdentity: lookupSlackActorIdentityMock,
}));

import { persistThreadStateById } from "@/chat/runtime/thread-state";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { upsertAgentTurnSessionRecord } from "@/chat/state/turn-session";
import { GET } from "@/handlers/oauth-callback";
import type { WaitUntilFn } from "@/handlers/types";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

const testWaitUntil: WaitUntilFn = (task) => {
  waitUntilCallbacks.push(typeof task === "function" ? task : () => task);
};

function makeRequest(url: string): Request {
  return new Request(url, { method: "GET" });
}

async function putStoredState(key: string, value: unknown): Promise<void> {
  await getStateAdapter().set(key, value);
}

function configureGitHubOAuthEnv() {
  process.env.GITHUB_APP_CLIENT_ID = "github-client-id";
  process.env.GITHUB_APP_CLIENT_SECRET = "github-client-secret";
  process.env.JUNIOR_BASE_URL = BASE_URL;
}

function mockJsonFetch(payload: unknown) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => payload,
  }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
}

beforeEach(async () => {
  process.env.JUNIOR_STATE_ADAPTER = "memory";
  await disconnectStateAdapter();
  await getStateAdapter().connect();
  lookupSlackActorIdentityMock.mockReset();
  lookupSlackActorIdentityMock.mockResolvedValue({
    userId: "U777",
    userName: "requester",
  });
  resumeSlackTurnMock.mockReset();
  waitUntilCallbacks.length = 0;
});

afterEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
  await disconnectStateAdapter();
});

describe("oauth callback scoped auth resume", () => {
  it("resumes from the pending auth record matching the requested scope", async () => {
    const conversationId = "slack:C123:123.456";
    const sessionId = "turn_scoped_auth_message";
    const nowMs = Date.now();
    let beforeStartResult: unknown;
    resumeSlackTurnMock.mockImplementation(async (input) => {
      beforeStartResult = await input.beforeStart();
    });
    await persistThreadStateById(conversationId, {
      conversation: {
        schemaVersion: 1,
        messages: [
          {
            id: "scoped_auth_message",
            role: "user",
            text: "create the issue",
            createdAtMs: nowMs,
            author: { userId: "U777" },
            meta: { slackTs: "111.222" },
          },
        ],
        piMessages: [],
        compactions: [],
        backfill: {},
        processing: {
          pendingAuth: {
            kind: "plugin",
            provider: "github",
            requesterId: "U777",
            scope: "repo",
            sessionId,
            linkSentAtMs: nowMs,
          },
        },
        stats: {
          compactedMessageCount: 0,
          estimatedContextTokens: 0,
          totalMessageCount: 1,
          updatedAtMs: nowMs,
        },
        vision: { byFileId: {} },
      },
    });
    await upsertAgentTurnSessionRecord({
      conversationId,
      sessionId,
      sliceId: 0,
      state: "awaiting_resume",
      resumeReason: "auth",
      piMessages: [],
    });
    await putStoredState("oauth-state:github-scoped-resume", {
      userId: "U777",
      provider: "github",
      channelId: "C123",
      destination: {
        platform: "slack",
        teamId: "T123",
        channelId: "C123",
      },
      threadTs: "123.456",
      pendingMessage: "create the issue",
      resumeConversationId: conversationId,
      resumeSessionId: sessionId,
      scope: "repo",
    });

    configureGitHubOAuthEnv();
    mockJsonFetch({
      access_token: "github-user-token",
      refresh_token: "github-refresh-token",
      expires_in: 28_800,
      scope: "",
    });

    const response = await GET(
      makeRequest(
        "https://example.com/api/oauth/callback/github?code=valid-code&state=github-scoped-resume",
      ),
      "github",
      testWaitUntil,
    );

    expect(response.status).toBe(200);
    await waitUntilCallbacks.at(-1)?.();
    expect(resumeSlackTurnMock).toHaveBeenCalledTimes(1);
    expect(beforeStartResult).toMatchObject({
      messageText: "create the issue",
      replyContext: {
        pendingAuth: {
          kind: "plugin",
          provider: "github",
          requesterId: "U777",
          scope: "repo",
          sessionId,
        },
      },
    });
  });
});
