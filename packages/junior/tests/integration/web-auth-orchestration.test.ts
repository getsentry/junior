import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apiTurnIdForMessage } from "@/chat/api-turns/work";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import {
  getLatestMcpAuthSessionForUserProvider,
  getMcpStoredOAuthCredentials,
} from "@/chat/mcp/auth-store";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { listTurnSummaries } from "@/chat/task-execution/checkpoint";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import {
  closeApiTurnWorkFixture,
  createConversationWorkWebHarness,
  type ConversationWorkWebHarness,
} from "../fixtures/api-turn";
import { completeMcpOauthCallbackRoute } from "../fixtures/mcp-oauth-callback-harness";
import {
  createPluginAppFixture,
  type PluginAppFixture,
} from "../fixtures/plugin-app";
import {
  loadConversationState,
  streamScript,
} from "../fixtures/conversation-work";
import { EVAL_MCP_AUTH_PROVIDER } from "../msw/handlers/eval-mcp-auth";

/**
 * Web interactive auth through the durable queue.
 *
 * Common dashboard behaviors only. Fake model stream. Real web ingress,
 * worker, agent, pending-messages API, and MCP OAuth callback fixtures.
 * Matches the Slack MCP auth orchestration approach so park / resume /
 * supersede bugs stay covered at the product boundary.
 */

const ORIGINAL_ENV = { ...process.env };
const EVAL_MCP_PLUGIN_ROOT = path.resolve(
  import.meta.dirname,
  "../fixtures/plugins/eval-auth",
);
const EVAL_AUTH_TOOL_NAME = "mcp__eval-auth__budget-echo";

/** Search connects the auth MCP provider; missing credentials park for auth. */
function streamMcpSearch(replyAfterConnect: string) {
  return streamScript(
    {
      tool: "searchMcpTools",
      args: { provider: EVAL_MCP_AUTH_PROVIDER, query: "budget echo" },
    },
    replyAfterConnect,
  );
}

/** Search discloses the tool before the same turn calls it. */
function streamMcpSearchAndCall(replyAfterCall: string) {
  return streamScript(
    {
      tool: "searchMcpTools",
      args: { provider: EVAL_MCP_AUTH_PROVIDER, query: "budget echo" },
    },
    {
      tool: "callMcpTool",
      args: {
        tool_name: EVAL_AUTH_TOOL_NAME,
        arguments: { query: "budget" },
      },
    },
    replyAfterCall,
  );
}

/** Complete the latest MCP OAuth session for the web actor through the real callback. */
async function completeAuth(
  userId: string,
  agentRunner: AgentRunner,
  conversationWorkQueue: ConversationWorkQueue,
): Promise<void> {
  const session = await getLatestMcpAuthSessionForUserProvider(
    userId,
    EVAL_MCP_AUTH_PROVIDER,
  );
  expect(session?.authSessionId).toEqual(expect.any(String));
  await completeMcpOauthCallbackRoute({
    provider: EVAL_MCP_AUTH_PROVIDER,
    authSessionId: session!.authSessionId,
    agentRunner,
    conversationWorkQueue,
  });
}

/** Participant pending-messages exposes a connect prompt for the parked turn. */
async function expectWebAuthParked(
  q: ConversationWorkWebHarness,
  conversationId: string,
) {
  const pending = await q.pendingMessages(conversationId);
  expect(pending.authorization).toMatchObject({
    authorizationUrl: expect.stringMatching(/^https?:\/\//),
    label: expect.any(String),
    completionText: expect.any(String),
  });
  expect(
    (await loadConversationState(conversationId)).processing.pendingAuth,
  ).toMatchObject({
    kind: "mcp",
    provider: EVAL_MCP_AUTH_PROVIDER,
    actorId: q.actor.userId,
  });
  await expect(listTurnSummaries(conversationId)).resolves.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ state: "paused", resumeReason: "auth" }),
    ]),
  );
}

describe("web auth orchestration", () => {
  let pluginApp: PluginAppFixture | undefined;

  beforeEach(async () => {
    await disconnectStateAdapter();
    process.env = {
      ...ORIGINAL_ENV,
      JUNIOR_BASE_URL: "https://junior.example.com",
      JUNIOR_SECRET: "junior-test-secret",
      JUNIOR_STATE_ADAPTER: "memory",
      SLACK_BOT_TOKEN: "xoxb-test-token",
    };
    pluginApp = await createPluginAppFixture([EVAL_MCP_PLUGIN_ROOT]);
  });

  afterEach(async () => {
    await closeApiTurnWorkFixture();
    await pluginApp?.cleanup();
    pluginApp = undefined;
    process.env = { ...ORIGINAL_ENV };
  });

  it("parks a web turn for MCP auth, exposes the prompt, and resumes after OAuth", async () => {
    const q = await createConversationWorkWebHarness({
      modelStream: streamMcpSearchAndCall("Eval Auth tool completed."),
    });
    const started = await q.start({
      idempotencyKey: "web-auth-park-resume-1",
      message: "use eval-auth and confirm the connection",
    });
    await q.drain();
    await expectWebAuthParked(q, started.conversationId);

    await completeAuth(q.actor.userId, q.agentRunner, q.queue);
    await q.drain();

    expect(
      (await loadConversationState(started.conversationId)).processing
        .pendingAuth,
    ).toBeUndefined();
    await expect(
      getMcpStoredOAuthCredentials(q.actor.userId, EVAL_MCP_AUTH_PROVIDER),
    ).resolves.toMatchObject({
      tokens: expect.objectContaining({ access_token: expect.any(String) }),
    });
    await expect(
      q.pendingMessages(started.conversationId),
    ).resolves.not.toHaveProperty("authorization");
    const history = await q.historyTexts(started.conversationId);
    expect(history.some((text) => text.includes("Eval Auth tool completed"))).toBe(
      true,
    );
    await expect(listTurnSummaries(started.conversationId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: "completed", surface: "api" }),
      ]),
    );
  });

  it("supersedes an auth-parked web turn and clears the dashboard prompt", async () => {
    const q = await createConversationWorkWebHarness({
      modelStream: streamMcpSearch("Eval Auth is connected."),
    });
    const started = await q.start({
      idempotencyKey: "web-auth-supersede-1",
      message: "connect eval-auth first",
    });
    await q.drain();
    await expectWebAuthParked(q, started.conversationId);
    const parkedTurnId = apiTurnIdForMessage(started.messageId);

    q.setModelStream(streamScript("Answered without waiting for auth."));
    const followUp = await q.continue({
      conversationId: started.conversationId,
      idempotencyKey: "web-auth-supersede-2",
      message: "skip auth and answer this instead",
    });
    await q.drain();

    await expect(listTurnSummaries(started.conversationId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          turnId: parkedTurnId,
          state: "abandoned",
        }),
        expect.objectContaining({
          turnId: apiTurnIdForMessage(followUp.messageId),
          state: "completed",
          surface: "api",
        }),
      ]),
    );
    await expect(
      q.pendingMessages(started.conversationId),
    ).resolves.not.toHaveProperty("authorization");
    // pendingAuth stays so a still-in-flight OAuth connect can store tokens;
    // only the dashboard banner and parked turn are cleared/abandoned.
    expect(
      (await loadConversationState(started.conversationId)).processing
        .pendingAuth,
    ).toMatchObject({
      kind: "mcp",
      provider: EVAL_MCP_AUTH_PROVIDER,
      actorId: q.actor.userId,
    });
    const history = await q.historyTexts(started.conversationId);
    expect(
      history.some((text) => text.includes("Answered without waiting for auth")),
    ).toBe(true);
  });

  it("does not resume a superseded web auth turn after a late OAuth callback", async () => {
    const q = await createConversationWorkWebHarness({
      modelStream: streamMcpSearch("Eval Auth is connected."),
    });
    const started = await q.start({
      idempotencyKey: "web-auth-late-oauth-1",
      message: "connect eval-auth first",
    });
    await q.drain();
    await expectWebAuthParked(q, started.conversationId);
    const parkedSession = await getLatestMcpAuthSessionForUserProvider(
      q.actor.userId,
      EVAL_MCP_AUTH_PROVIDER,
    );
    expect(parkedSession?.authSessionId).toEqual(expect.any(String));

    q.setModelStream(streamScript("Moved on without auth."));
    await q.continue({
      conversationId: started.conversationId,
      idempotencyKey: "web-auth-late-oauth-2",
      message: "never mind the provider",
    });
    await q.drain();
    await expect(
      q.pendingMessages(started.conversationId),
    ).resolves.not.toHaveProperty("authorization");

    await completeMcpOauthCallbackRoute({
      provider: EVAL_MCP_AUTH_PROVIDER,
      authSessionId: parkedSession!.authSessionId,
      agentRunner: q.agentRunner,
      conversationWorkQueue: q.queue,
    });
    await q.drain();

    await expect(
      q.pendingMessages(started.conversationId),
    ).resolves.not.toHaveProperty("authorization");
    // Late OAuth after supersede still stores credentials (pendingAuth kept),
    // but must not resume the abandoned parked turn.
    await expect(
      getMcpStoredOAuthCredentials(q.actor.userId, EVAL_MCP_AUTH_PROVIDER),
    ).resolves.toMatchObject({
      tokens: expect.objectContaining({ access_token: expect.any(String) }),
    });
    const history = await q.historyTexts(started.conversationId);
    expect(history.some((text) => text.includes("Moved on without auth"))).toBe(
      true,
    );
    expect(
      history.some((text) => text.includes("Eval Auth is connected")),
    ).toBe(false);
    await expect(listTurnSummaries(started.conversationId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          turnId: apiTurnIdForMessage(started.messageId),
          state: "abandoned",
        }),
      ]),
    );
  });
});
