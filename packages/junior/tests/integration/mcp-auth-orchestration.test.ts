import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { listTurnSummaries } from "@/chat/task-execution/checkpoint";
import {
  getLatestMcpAuthSessionForUserProvider,
  getMcpStoredOAuthCredentials,
} from "@/chat/mcp/auth-store";
import {
  CONVERSATION_ID,
  createConversationWorkSlackHarness,
  loadConversationState,
  streamScript,
  type ConversationWorkSlackHarness,
} from "../fixtures/conversation-work";
import { completeMcpOauthCallbackRoute } from "../fixtures/mcp-oauth-callback-harness";
import {
  createPluginAppFixture,
  type PluginAppFixture,
} from "../fixtures/plugin-app";
import { EVAL_MCP_AUTH_PROVIDER } from "../msw/handlers/eval-mcp-auth";
import { resetSlackApiMockState } from "../msw/handlers/slack-api";

/**
 * Actor-scoped MCP auth UX through the durable queue.
 * See https://github.com/getsentry/junior/issues/1377
 *
 * Prove one product outcome per case through live Slack ingress → worker →
 * real agent → real MCP/OAuth fixtures. Fake only the model stream and Slack
 * HTTP. OAuth callback resume and pending-auth freshness stay in their owning
 * suites.
 */

const ORIGINAL_ENV = { ...process.env };
const EVAL_MCP_PLUGIN_ROOT = path.resolve(
  import.meta.dirname,
  "../fixtures/plugins/eval-auth",
);
const ALICE = "UALICE";
const BOB = "UBOB";
const AUTH_NOTICE = /I need access to Eval Auth to continue/;

/** loadSkill activates the MCP provider; missing credentials park for auth. */
function streamMcpLoad(replyAfterConnect: string) {
  return streamScript(
    { tool: "loadSkill", args: { skill_name: EVAL_MCP_AUTH_PROVIDER } },
    replyAfterConnect,
  );
}

/** Complete the latest MCP OAuth session for one actor through the real callback. */
async function completeAuth(userId: string, agentRunner: AgentRunner) {
  const session = await getLatestMcpAuthSessionForUserProvider(
    userId,
    EVAL_MCP_AUTH_PROVIDER,
  );
  expect(session?.authSessionId).toEqual(expect.any(String));
  await completeMcpOauthCallbackRoute({
    provider: EVAL_MCP_AUTH_PROVIDER,
    authSessionId: session!.authSessionId,
    agentRunner,
  });
}

/** Visible MCP auth pause owned by the requesting actor. */
async function expectAuthParkedFor(
  userId: string,
  q: ConversationWorkSlackHarness,
) {
  expect(q.replies().some((text) => AUTH_NOTICE.test(text))).toBe(true);
  expect(q.authLinksFor(userId).length).toBeGreaterThan(0);
  expect((await loadConversationState()).processing.pendingAuth).toMatchObject({
    kind: "mcp",
    provider: EVAL_MCP_AUTH_PROVIDER,
    actorId: userId,
  });
  await expect(listTurnSummaries(CONVERSATION_ID)).resolves.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ state: "paused", resumeReason: "auth" }),
    ]),
  );
}

/** Connect Eval Auth for Alice through a real mention → park → OAuth path. */
async function connectAlice(q: ConversationWorkSlackHarness): Promise<void> {
  await q.mention(ALICE, "use eval-auth and confirm the connection");
  await q.drain();
  await expectAuthParkedFor(ALICE, q);
  await completeAuth(ALICE, q.agentRunner);
  expect((await loadConversationState()).processing.pendingAuth).toBeUndefined();
  await expect(
    getMcpStoredOAuthCredentials(ALICE, EVAL_MCP_AUTH_PROVIDER),
  ).resolves.toMatchObject({
    tokens: expect.objectContaining({ access_token: expect.any(String) }),
  });
  expect(
    q.replies().some((text) => text.includes("Eval Auth is connected")),
  ).toBe(true);
}

describe("mcp auth orchestration", () => {
  let pluginApp: PluginAppFixture | undefined;

  beforeEach(async () => {
    resetSlackApiMockState();
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
    await disconnectStateAdapter();
    await pluginApp?.cleanup();
    pluginApp = undefined;
    process.env = { ...ORIGINAL_ENV };
    resetSlackApiMockState();
  });

  it("connects MCP for the requesting actor and reuses it on that actor's later turn", async () => {
    const q = await createConversationWorkSlackHarness({
      modelStream: streamMcpLoad("Eval Auth is connected."),
    });

    await connectAlice(q);
    const aliceLinksAfterConnect = q.authLinksFor(ALICE).length;

    q.setModelStream(streamMcpLoad("Connection still works."));
    await q.mention(ALICE, "use eval-auth again");
    await q.drain();

    expect(q.authLinksFor(ALICE)).toHaveLength(aliceLinksAfterConnect);
    expect((await loadConversationState()).processing.pendingAuth).toBeUndefined();
    expect(
      q.replies().some((text) => text.includes("Connection still works")),
    ).toBe(true);
  });

  it("does not prompt another actor after prior MCP use on an unrelated request", async () => {
    const q = await createConversationWorkSlackHarness({
      modelStream: streamMcpLoad("Eval Auth is connected."),
    });
    await connectAlice(q);

    q.setModelStream(streamScript("Deploy looks fine."));
    await q.mention(BOB, "what is the deploy status?");
    await q.drain();

    // Prior Alice MCP use must not force Bob to authorize an unused provider.
    expect(q.authLinksFor(BOB)).toEqual([]);
    expect(q.replies().some((text) => AUTH_NOTICE.test(text))).toBe(false);
    expect((await loadConversationState()).processing.pendingAuth).toBeUndefined();
    expect(q.replies().at(-1)).toContain("Deploy looks fine.");
  });

  it("prompts only the new actor when that actor intentionally uses MCP", async () => {
    const q = await createConversationWorkSlackHarness({
      modelStream: streamMcpLoad("Eval Auth is connected."),
    });
    await connectAlice(q);
    const aliceLinksAfterConnect = q.authLinksFor(ALICE).length;

    q.setModelStream(streamMcpLoad("Bob is connected."));
    await q.mention(BOB, "use eval-auth for my own lookup");
    await q.drain();

    await expectAuthParkedFor(BOB, q);
    expect(q.authLinksFor(ALICE)).toHaveLength(aliceLinksAfterConnect);
    const bobCredentials = await getMcpStoredOAuthCredentials(
      BOB,
      EVAL_MCP_AUTH_PROVIDER,
    );
    expect(bobCredentials?.tokens?.access_token).toBeUndefined();
  });
});
