import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stopConversationTurn } from "@/chat/conversations/stop";
import { conversationTurnIdForMessage } from "@/chat/conversations/web-input";
import { getLatestMcpAuthSessionForUserProvider } from "@/chat/mcp/auth-store";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { listTurnSummaries } from "@/chat/task-execution/checkpoint";
import {
  closeConversationFixture,
  createConversationWebHarness,
} from "../fixtures/conversation";
import {
  completeLatestMcpAuth,
  expectMcpAuthParked,
  expectMcpAuthCleared,
  expectMcpAuthCredentialsStored,
  expectWebMcpAuthParked,
  streamMcpSearch,
  streamMcpSearchAndCall,
} from "../fixtures/mcp-auth-orchestration";
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
    await closeConversationFixture();
    await pluginApp?.cleanup();
    pluginApp = undefined;
    process.env = { ...ORIGINAL_ENV };
  });

  it("parks a web Turn for MCP auth, shows the prompt, and resumes after OAuth", async () => {
    const q = await createConversationWebHarness(
      streamMcpSearchAndCall("Eval Auth tool completed."),
    );
    const started = await q.start({
      idempotencyKey: "web-auth-park-resume-1",
      message: "use eval-auth and confirm the connection",
    });
    await q.drain();
    await expectWebMcpAuthParked({
      harness: q,
      conversationId: started.conversationId,
    });

    await completeLatestMcpAuth({
      userId: q.actor.userId,
      agentRunner: q.agentRunner,
      conversationWorkQueue: q.queue,
    });
    await q.drain();

    await expectMcpAuthCleared(started.conversationId);
    await expectMcpAuthCredentialsStored(q.actor.userId);
    await expect(
      q.pendingMessages(started.conversationId),
    ).resolves.not.toHaveProperty("authorization");
    const history = await q.historyTexts(started.conversationId);
    expect(
      history.some((text) => text.includes("Eval Auth tool completed")),
    ).toBe(true);
    await expect(listTurnSummaries(started.conversationId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: "completed", surface: "api" }),
      ]),
    );
  });

  it("resumes a web Turn as the user who started it", async () => {
    const q = await createConversationWebHarness(
      streamMcpSearchAndCall("Eval Auth tool completed."),
    );
    const conversationId = "slack:CAPI123:1787718000.000001";
    await q.conversationStore.recordActivity({
      actor: {
        email: "root@example.com",
        platform: "slack",
        slackUserId: "UAPIROOT",
        teamId: "TAPIROOT",
      },
      conversationId,
      destination: {
        channelId: "CAPI123",
        platform: "slack",
        teamId: "TAPIROOT",
      },
      source: "slack",
      visibility: "private",
    });
    await q.continue({
      conversationId,
      idempotencyKey: "web-auth-park-resume-1",
      message: "use eval-auth and confirm the connection",
    });
    await q.drain();
    await expectMcpAuthParked({
      actorId: q.actor.userId,
      conversationId,
    });

    await completeLatestMcpAuth({
      userId: q.actor.userId,
      agentRunner: q.agentRunner,
      conversationWorkQueue: q.queue,
    });
    await q.drain();

    expect(q.agentRuns.map((run) => run.actor)).toEqual([q.actor, q.actor]);
  });

  it("supersedes an auth-paused web Turn and clears the prompt", async () => {
    const q = await createConversationWebHarness(
      streamMcpSearch("Eval Auth is connected."),
    );
    const started = await q.start({
      idempotencyKey: "web-auth-supersede-1",
      message: "connect eval-auth first",
    });
    await q.drain();
    await expectWebMcpAuthParked({
      harness: q,
      conversationId: started.conversationId,
    });
    const parkedTurnId = conversationTurnIdForMessage(started.messageId);

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
          turnId: conversationTurnIdForMessage(followUp.messageId),
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
      history.some((text) =>
        text.includes("Answered without waiting for auth"),
      ),
    ).toBe(true);
  });

  it("stops queued and auth-paused web Turns without process state", async () => {
    const q = await createConversationWebHarness(
      streamMcpSearch("This response must not run."),
    );
    const started = await q.start({
      idempotencyKey: "web-auth-stop-1",
      message: "connect eval-auth first",
    });
    await q.drain();
    await expectWebMcpAuthParked({
      harness: q,
      conversationId: started.conversationId,
    });
    const parkedTurnId = conversationTurnIdForMessage(started.messageId);

    await q.continue({
      conversationId: started.conversationId,
      idempotencyKey: "web-auth-stop-2",
      message: "cancel this queued follow-up",
    });
    await expect(
      stopConversationTurn({
        conversationId: started.conversationId,
        conversationStore: q.conversationStore,
        queue: q.queue,
        state: q.state,
      }),
    ).resolves.toMatchObject({ status: "requested" });
    await q.drain();

    await expect(listTurnSummaries(started.conversationId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          turnId: parkedTurnId,
          state: "paused",
          resumeReason: "auth",
        }),
      ]),
    );
    await expect(
      q.pendingMessages(started.conversationId),
    ).resolves.toHaveProperty("authorization");

    await expect(
      stopConversationTurn({
        conversationId: started.conversationId,
        conversationStore: q.conversationStore,
        queue: q.queue,
        state: q.state,
      }),
    ).resolves.toMatchObject({ status: "requested" });
    await q.drain();

    await expect(listTurnSummaries(started.conversationId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          turnId: parkedTurnId,
          state: "abandoned",
        }),
      ]),
    );
    await expect(
      q.pendingMessages(started.conversationId),
    ).resolves.not.toHaveProperty("authorization");
    await expectMcpAuthCleared(started.conversationId);
    expect(q.agentRuns).toHaveLength(1);
  });

  it("does not resume a superseded web auth turn after a late OAuth callback", async () => {
    const q = await createConversationWebHarness(
      streamMcpSearch("Eval Auth is connected."),
    );
    const started = await q.start({
      idempotencyKey: "web-auth-late-oauth-1",
      message: "connect eval-auth first",
    });
    await q.drain();
    await expectWebMcpAuthParked({
      harness: q,
      conversationId: started.conversationId,
    });
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
    await expectMcpAuthCredentialsStored(q.actor.userId);
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
          turnId: conversationTurnIdForMessage(started.messageId),
          state: "abandoned",
        }),
      ]),
    );
  });
});
