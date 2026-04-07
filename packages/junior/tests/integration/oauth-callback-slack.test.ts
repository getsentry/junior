import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCapturedSlackApiCalls,
  resetSlackApiMockState,
} from "../msw/handlers/slack-api";

const { generateAssistantReplyMock } = vi.hoisted(() => ({
  generateAssistantReplyMock: vi.fn(),
}));

vi.mock("@/chat/respond", () => ({
  generateAssistantReply: generateAssistantReplyMock,
}));

const ORIGINAL_ENV = { ...process.env };
const EVAL_OAUTH_PLUGIN_ROOT = path.resolve(
  import.meta.dirname,
  "../fixtures/plugins/eval-oauth",
);

type StateAdapterModule = typeof import("@/chat/state/adapter");
type OAuthCallbackHarnessModule =
  typeof import("../fixtures/oauth-callback-harness");

let stateAdapterModule: StateAdapterModule;
let oauthCallbackHarnessModule: OAuthCallbackHarnessModule;

describe("oauth callback slack integration", () => {
  beforeEach(async () => {
    generateAssistantReplyMock.mockReset();
    generateAssistantReplyMock.mockResolvedValue({
      text: "Here are your Sentry issues.",
      diagnostics: {
        outcome: "success",
        toolCalls: [],
      },
    });
    resetSlackApiMockState();
    process.env = {
      ...ORIGINAL_ENV,
      JUNIOR_STATE_ADAPTER: "memory",
      JUNIOR_BASE_URL: "https://junior.example.com",
      JUNIOR_EXTRA_PLUGIN_ROOTS: JSON.stringify([EVAL_OAUTH_PLUGIN_ROOT]),
    };
    vi.resetModules();
    stateAdapterModule = await import("@/chat/state/adapter");
    oauthCallbackHarnessModule =
      await import("../fixtures/oauth-callback-harness");
    await stateAdapterModule.disconnectStateAdapter();
    await stateAdapterModule.getStateAdapter().connect();
  });

  afterEach(async () => {
    await stateAdapterModule.disconnectStateAdapter();
    process.env = { ...ORIGINAL_ENV };
  });

  it("publishes app home through the Slack MSW harness after generic OAuth callback", async () => {
    await stateAdapterModule
      .getStateAdapter()
      .set("oauth-state:eval-oauth-state", {
        userId: "U123",
        provider: "eval-oauth",
      });

    const response = await oauthCallbackHarnessModule.runOauthCallbackRoute({
      provider: "eval-oauth",
      state: "eval-oauth-state",
      code: "eval-oauth-code",
    });

    expect(response.status).toBe(200);
    expect(getCapturedSlackApiCalls("views.publish")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          user_id: "U123",
          view: expect.objectContaining({
            type: "home",
          }),
        }),
      }),
    ]);
  });

  it("resumes a pending OAuth request with persisted thread context", async () => {
    await stateAdapterModule
      .getStateAdapter()
      .set("oauth-state:eval-oauth-resume-state", {
        userId: "U123",
        provider: "eval-oauth",
        channelId: "C123",
        threadTs: "1700000000.001",
        pendingMessage: "list my sentry issues",
      });
    await stateAdapterModule
      .getStateAdapter()
      .set("thread-state:slack:C123:1700000000.001", {
        conversation: {
          messages: [
            {
              id: "assistant-1",
              role: "assistant",
              text: "You need the budget by Friday.",
              createdAtMs: 1,
              author: {
                userName: "junior",
                isBot: true,
              },
            },
            {
              id: "user-1",
              role: "user",
              text: "list my sentry issues",
              createdAtMs: 2,
              author: {
                userId: "U123",
                userName: "dcramer",
              },
            },
          ],
        },
      });

    const response = await oauthCallbackHarnessModule.runOauthCallbackRoute({
      provider: "eval-oauth",
      state: "eval-oauth-resume-state",
      code: "eval-oauth-code",
    });

    expect(response.status).toBe(200);
    expect(generateAssistantReplyMock).toHaveBeenCalledWith(
      "list my sentry issues",
      expect.objectContaining({
        conversationContext: expect.stringContaining(
          "You need the budget by Friday.",
        ),
      }),
    );
    const resumeContext = generateAssistantReplyMock.mock.calls[0]?.[1] as {
      conversationContext?: string;
    };
    expect(resumeContext.conversationContext).not.toContain(
      "list my sentry issues",
    );

    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          params: expect.objectContaining({
            channel: "C123",
            thread_ts: "1700000000.001",
            text: "Your Eval-oauth account is now connected. Processing your request...",
          }),
        }),
        expect.objectContaining({
          params: expect.objectContaining({
            channel: "C123",
            thread_ts: "1700000000.001",
            text: "Here are your Sentry issues.",
          }),
        }),
      ]),
    );
  });

  it("does not resume an explicit reconnect flow from thread history", async () => {
    const { maybeExecuteJrRpcCustomCommand } =
      await import("@/chat/capabilities/jr-rpc-command");
    const { SkillCapabilityRuntime } =
      await import("@/chat/capabilities/runtime");
    const { CredentialUnavailableError } =
      await import("@/chat/credentials/broker");

    const runtime = new SkillCapabilityRuntime({
      broker: {
        issue: async () => {
          throw new CredentialUnavailableError(
            "eval-oauth",
            "No eval-oauth credentials available.",
          );
        },
      },
      requesterId: "U123",
    });
    const startedExplicitOAuthProviders = new Map<string, boolean>();

    const oauthStart = await maybeExecuteJrRpcCustomCommand(
      "jr-rpc oauth-start eval-oauth",
      {
        capabilityRuntime: runtime,
        activeSkill: null,
        requesterId: "U123",
        channelId: "C123",
        threadTs: "1700000000.001",
        startedExplicitOAuthProviders,
      },
    );

    expect(oauthStart.handled).toBe(true);
    if (!oauthStart.handled) {
      throw new Error("expected jr-rpc oauth-start to be handled");
    }
    expect(oauthStart.result.exit_code).toBe(0);

    const ephemeralCalls = getCapturedSlackApiCalls("chat.postEphemeral");
    expect(ephemeralCalls).toHaveLength(1);
    const match = String(ephemeralCalls[0]?.params.text).match(/^<([^|>]+)\|/);
    if (!match?.[1]) {
      throw new Error(
        `Expected Slack link markup, got: ${String(ephemeralCalls[0]?.params.text)}`,
      );
    }
    const authorizeUrl = new URL(match[1]);
    const state = authorizeUrl.searchParams.get("state");
    expect(state).toBeTruthy();
    const issueCredential = await maybeExecuteJrRpcCustomCommand(
      "jr-rpc issue-credential eval-oauth.read",
      {
        capabilityRuntime: runtime,
        activeSkill: null,
        requesterId: "U123",
        channelId: "C123",
        threadTs: "1700000000.001",
        userMessage:
          "deauth me from eval-oauth, and then reauth me so we can test",
        startedExplicitOAuthProviders,
      },
    );

    expect(issueCredential.handled).toBe(true);
    if (!issueCredential.handled) {
      throw new Error("expected jr-rpc issue-credential to be handled");
    }
    expect(issueCredential.result.exit_code).toBe(0);
    expect(JSON.parse(issueCredential.result.stdout)).toMatchObject({
      oauth_started: true,
      private_delivery_sent: true,
    });
    expect(getCapturedSlackApiCalls("chat.postEphemeral")).toHaveLength(1);

    const stored = await stateAdapterModule.getStateAdapter().get<{
      pendingMessage?: string;
    }>(`oauth-state:${state}`);
    expect(stored?.pendingMessage).toBeUndefined();

    await stateAdapterModule
      .getStateAdapter()
      .set("thread-state:slack:C123:1700000000.001", {
        conversation: {
          messages: [
            {
              id: "user-1",
              role: "user",
              text: "deauth me from eval-oauth, and then reauth me so we can test",
              createdAtMs: 1,
              author: {
                userId: "U123",
                userName: "dcramer",
              },
            },
            {
              id: "assistant-1",
              role: "assistant",
              text: "deauthed and reauth flow started - check your DMs for the authorization link.",
              createdAtMs: 2,
              author: {
                userName: "junior",
                isBot: true,
              },
            },
          ],
        },
      });

    const response = await oauthCallbackHarnessModule.runOauthCallbackRoute({
      provider: "eval-oauth",
      state: state ?? "",
      code: "eval-oauth-code",
    });

    expect(response.status).toBe(200);
    expect(generateAssistantReplyMock).not.toHaveBeenCalled();
    const postedMessages = getCapturedSlackApiCalls("chat.postMessage");
    expect(postedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          params: expect.objectContaining({
            channel: "C123",
            thread_ts: "1700000000.001",
            text: "Your Eval-oauth account is now connected. You can start using Eval-oauth commands.",
          }),
        }),
      ]),
    );
    expect(
      postedMessages.map((call) => String(call.params.text ?? "")),
    ).not.toContain(
      "Your Eval-oauth account is now connected. Processing your request...",
    );
  });
});
