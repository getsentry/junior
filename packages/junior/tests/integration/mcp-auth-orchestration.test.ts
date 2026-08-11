import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import {
  deleteMcpStoredOAuthCredentials,
  getLatestMcpAuthSessionForUserProvider,
  getMcpStoredOAuthCredentials,
} from "@/chat/mcp/auth-store";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { listTurnSummaries } from "@/chat/task-execution/checkpoint";
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
 * Common user behaviors only. Fake model stream + Slack HTTP. Real ingress,
 * worker, agent, MCP/OAuth fixtures. OAuth callback route mechanics and
 * pending-auth freshness stay in their owning suites.
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

/** No MCP auth prompt delivered to this actor. */
function expectNoAuthFor(userId: string, q: ConversationWorkSlackHarness) {
  expect(q.authLinksFor(userId)).toEqual([]);
}

/** Connect Eval Auth for one actor through a real mention → park → OAuth path. */
async function connectActor(
  q: ConversationWorkSlackHarness,
  userId: string,
  replyText = "Eval Auth is connected.",
): Promise<void> {
  q.setModelStream(streamMcpLoad(replyText));
  await q.mention(userId, "use eval-auth and confirm the connection");
  await q.drain();
  await expectAuthParkedFor(userId, q);
  await completeAuth(userId, q.agentRunner);
  expect((await loadConversationState()).processing.pendingAuth).toBeUndefined();
  await expect(
    getMcpStoredOAuthCredentials(userId, EVAL_MCP_AUTH_PROVIDER),
  ).resolves.toMatchObject({
    tokens: expect.objectContaining({ access_token: expect.any(String) }),
  });
  expect(q.replies().some((text) => text.includes(replyText))).toBe(true);
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

  it("parks first MCP use for the requesting actor and resumes after OAuth", async () => {
    const q = await createConversationWorkSlackHarness({
      modelStream: streamMcpLoad("Eval Auth is connected."),
    });

    await q.mention(ALICE, "use eval-auth and confirm the connection");
    await q.drain();
    await expectAuthParkedFor(ALICE, q);
    expectNoAuthFor(BOB, q);

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
    await expect(listTurnSummaries(CONVERSATION_ID)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: "completed" }),
      ]),
    );
  });

  it("reuses the same actor's MCP connection on a later turn without another prompt", async () => {
    const q = await createConversationWorkSlackHarness({
      modelStream: streamMcpLoad("Eval Auth is connected."),
    });
    await connectActor(q, ALICE);
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

  it("re-prompts the same actor when stored MCP credentials are gone", async () => {
    const q = await createConversationWorkSlackHarness({
      modelStream: streamMcpLoad("Eval Auth is connected."),
    });
    await connectActor(q, ALICE);
    await deleteMcpStoredOAuthCredentials(ALICE, EVAL_MCP_AUTH_PROVIDER);
    await expect(
      getMcpStoredOAuthCredentials(ALICE, EVAL_MCP_AUTH_PROVIDER),
    ).resolves.toBeUndefined();
    const aliceLinksAfterConnect = q.authLinksFor(ALICE).length;

    q.setModelStream(streamMcpLoad("Reconnected after missing credentials."));
    await q.mention(ALICE, "use eval-auth again");
    await q.drain();

    await expectAuthParkedFor(ALICE, q);
    expect(q.authLinksFor(ALICE).length).toBeGreaterThan(aliceLinksAfterConnect);

    await completeAuth(ALICE, q.agentRunner);
    expect(
      q.replies().some((text) =>
        text.includes("Reconnected after missing credentials"),
      ),
    ).toBe(true);
  });

  it("does not prompt another actor after prior MCP use on an unrelated request", async () => {
    const q = await createConversationWorkSlackHarness({
      modelStream: streamMcpLoad("Eval Auth is connected."),
    });
    await connectActor(q, ALICE);

    // Bob's request never calls Eval Auth. Prior Alice MCP history must not force him to auth.
    q.setModelStream(
      streamScript(
        { tool: "systemTime", args: {} },
        "Deploy looks fine.",
      ),
    );
    await q.mention(BOB, "what time is it for the deploy?");
    await q.drain();

    expectNoAuthFor(BOB, q);
    expect((await loadConversationState()).processing.pendingAuth).toBeUndefined();
    expect(q.replies().at(-1)).toContain("Deploy looks fine.");
    await expect(
      getMcpStoredOAuthCredentials(BOB, EVAL_MCP_AUTH_PROVIDER),
    ).resolves.toBeUndefined();
  });

  it("prompts only the new actor when that actor intentionally uses MCP", async () => {
    const q = await createConversationWorkSlackHarness({
      modelStream: streamMcpLoad("Eval Auth is connected."),
    });
    await connectActor(q, ALICE);
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

  it("keeps passive cross-actor context from flipping authority or prompting auth", async () => {
    const q = await createConversationWorkSlackHarness({
      modelStream: streamMcpLoad("Eval Auth is connected."),
      subscribedShouldReply: false,
    });
    await connectActor(q, ALICE);
    const replyCountAfterConnect = q.replies().length;
    const aliceLinksAfterConnect = q.authLinksFor(ALICE).length;

    // True passive: classifier skips. Bob's message is context only.
    await q.passive(BOB, "the record id is 42");
    await q.drain();

    expectNoAuthFor(BOB, q);
    expect(q.authLinksFor(ALICE)).toHaveLength(aliceLinksAfterConnect);
    expect(q.replies()).toHaveLength(replyCountAfterConnect);
    expect((await loadConversationState()).processing.pendingAuth).toBeUndefined();
    await expect(
      getMcpStoredOAuthCredentials(BOB, EVAL_MCP_AUTH_PROVIDER),
    ).resolves.toBeUndefined();

    // Alice continues under her own connection; Bob never becomes credential authority.
    q.setModelStream(streamMcpLoad("Record 42 noted under Alice."));
    await q.mention(ALICE, "continue with the record id from the thread");
    await q.drain();

    expectNoAuthFor(BOB, q);
    expect(q.authLinksFor(ALICE)).toHaveLength(aliceLinksAfterConnect);
    expect(
      q.replies().some((text) => text.includes("Record 42 noted under Alice")),
    ).toBe(true);
  });

  it("does not hand pending MCP auth to a passive bystander while the owner waits", async () => {
    const q = await createConversationWorkSlackHarness({
      modelStream: streamMcpLoad("Eval Auth is connected."),
      subscribedShouldReply: false,
    });
    await q.mention(ALICE, "use eval-auth and confirm the connection");
    await q.drain();
    await expectAuthParkedFor(ALICE, q);
    const aliceLinksWhilePending = q.authLinksFor(ALICE).length;
    const replyCountWhilePending = q.replies().length;

    await q.passive(BOB, "while you wait, the id is 99");
    await q.drain();

    // Bob stays context. Alice remains the pending auth owner.
    expect((await loadConversationState()).processing.pendingAuth).toMatchObject({
      kind: "mcp",
      provider: EVAL_MCP_AUTH_PROVIDER,
      actorId: ALICE,
    });
    expectNoAuthFor(BOB, q);
    expect(q.authLinksFor(ALICE)).toHaveLength(aliceLinksWhilePending);
    expect(q.replies()).toHaveLength(replyCountWhilePending);
    await expect(listTurnSummaries(CONVERSATION_ID)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: "paused", resumeReason: "auth" }),
      ]),
    );

    await completeAuth(ALICE, q.agentRunner);
    expect((await loadConversationState()).processing.pendingAuth).toBeUndefined();
    await expect(
      getMcpStoredOAuthCredentials(BOB, EVAL_MCP_AUTH_PROVIDER),
    ).resolves.toBeUndefined();
    expect(
      q.replies().some((text) => text.includes("Eval Auth is connected")),
    ).toBe(true);
  });

  it("does not restore another actor's MCP connection for a passive continuation reply", async () => {
    const q = await createConversationWorkSlackHarness({
      modelStream: streamMcpLoad("Eval Auth is connected."),
      subscribedShouldReply: true,
    });
    await connectActor(q, ALICE);

    // Subscribed follow-up from Bob continues the thread as Bob's turn.
    // Alice's prior MCP connection must not be restored under Bob.
    q.setModelStream(streamScript("Got the record id, thanks."));
    await q.passive(BOB, "the record id is 42");
    await q.drain();

    expectNoAuthFor(BOB, q);
    expect((await loadConversationState()).processing.pendingAuth).toBeUndefined();
    expect(q.replies().at(-1)).toContain("Got the record id");
    await expect(
      getMcpStoredOAuthCredentials(BOB, EVAL_MCP_AUTH_PROVIDER),
    ).resolves.toBeUndefined();
  });
});
