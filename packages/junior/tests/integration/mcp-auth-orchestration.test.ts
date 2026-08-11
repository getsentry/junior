import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteMcpStoredOAuthCredentials,
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
import {
  completeLatestMcpAuth,
  expectMcpAuthCleared,
  expectMcpAuthCredentialsStored,
  expectMcpAuthParked,
  streamMcpSearch,
  streamMcpSearchAndCall,
  streamOpenMcpSearch,
} from "../fixtures/mcp-auth-orchestration";
import {
  createPluginAppFixture,
  type PluginAppFixture,
} from "../fixtures/plugin-app";
import {
  EVAL_MCP_AUTH_PROVIDER,
  EVAL_MCP_NO_AUTH_PROVIDER,
} from "../msw/handlers/eval-mcp-auth";
import { resetSlackApiMockState } from "../msw/handlers/slack-api";

/**
 * MCP auth behavior through the durable queue.
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
const EVAL_MCP_OPEN_PLUGIN_ROOT = path.resolve(
  import.meta.dirname,
  "../fixtures/plugins/eval-mcp-open",
);
const ALICE = "UALICE";
const BOB = "UBOB";
const AUTH_NOTICE = /I need access to Eval Auth to continue/;

/** Slack delivery surface: public auth notice + private connect link. */
async function expectAuthParkedFor(
  userId: string,
  q: ConversationWorkSlackHarness,
) {
  await expectMcpAuthParked({
    actorId: userId,
    delivery: () => {
      expect(q.replies().some((text) => AUTH_NOTICE.test(text))).toBe(true);
      expect(q.authLinksFor(userId).length).toBeGreaterThan(0);
    },
  });
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
  q.setModelStream(streamMcpSearch(replyText));
  await q.mention(userId, "use eval-auth and confirm the connection");
  await q.drain();
  await expectAuthParkedFor(userId, q);
  await completeLatestMcpAuth({ userId, agentRunner: q.agentRunner });
  await expectMcpAuthCleared();
  await expectMcpAuthCredentialsStored(userId);
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
    pluginApp = await createPluginAppFixture([
      EVAL_MCP_PLUGIN_ROOT,
      EVAL_MCP_OPEN_PLUGIN_ROOT,
    ]);
  });

  afterEach(async () => {
    await disconnectStateAdapter();
    await pluginApp?.cleanup();
    pluginApp = undefined;
    process.env = { ...ORIGINAL_ENV };
    resetSlackApiMockState();
  });

  it("loads an MCP-owned skill without connecting or prompting for auth", async () => {
    const q = await createConversationWorkSlackHarness({
      modelStream: streamScript(
        { tool: "loadSkill", args: { skill_name: EVAL_MCP_AUTH_PROVIDER } },
        "Skill instructions loaded.",
      ),
    });

    await q.mention(ALICE, "load eval-auth without using its tools");
    await q.drain();

    expectNoAuthFor(ALICE, q);
    await expectMcpAuthCleared();
    expect(q.replies().at(-1)).toContain("Skill instructions loaded.");
    await expect(
      getMcpStoredOAuthCredentials(ALICE, EVAL_MCP_AUTH_PROVIDER),
    ).resolves.toBeUndefined();
  });

  it("searches before calling, parks for OAuth, and resumes the same turn", async () => {
    const q = await createConversationWorkSlackHarness({
      modelStream: streamMcpSearchAndCall("Eval Auth tool completed."),
    });

    await q.mention(ALICE, "use eval-auth and confirm the connection");
    await q.drain();
    await expectAuthParkedFor(ALICE, q);
    expectNoAuthFor(BOB, q);

    await completeLatestMcpAuth({ userId: ALICE, agentRunner: q.agentRunner });

    await expectMcpAuthCleared();
    await expectMcpAuthCredentialsStored(ALICE);
    expect(
      q.replies().some((text) => text.includes("Eval Auth tool completed")),
    ).toBe(true);
    await expect(listTurnSummaries(CONVERSATION_ID)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: "completed" }),
      ]),
    );
  });

  it("reuses the same actor's MCP connection on a later turn without another prompt", async () => {
    const q = await createConversationWorkSlackHarness({
      modelStream: streamMcpSearch("Eval Auth is connected."),
    });
    await connectActor(q, ALICE);
    const aliceLinksAfterConnect = q.authLinksFor(ALICE).length;

    q.setModelStream(streamMcpSearch("Connection still works."));
    await q.mention(ALICE, "use eval-auth again");
    await q.drain();

    expect(q.authLinksFor(ALICE)).toHaveLength(aliceLinksAfterConnect);
    await expectMcpAuthCleared();
    expect(
      q.replies().some((text) => text.includes("Connection still works")),
    ).toBe(true);
  });

  it("re-prompts the same actor when stored MCP credentials are gone", async () => {
    const q = await createConversationWorkSlackHarness({
      modelStream: streamMcpSearch("Eval Auth is connected."),
    });
    await connectActor(q, ALICE);
    await deleteMcpStoredOAuthCredentials(ALICE, EVAL_MCP_AUTH_PROVIDER);
    await expect(
      getMcpStoredOAuthCredentials(ALICE, EVAL_MCP_AUTH_PROVIDER),
    ).resolves.toBeUndefined();
    const aliceLinksAfterConnect = q.authLinksFor(ALICE).length;

    q.setModelStream(streamMcpSearch("Reconnected after missing credentials."));
    await q.mention(ALICE, "use eval-auth again");
    await q.drain();

    await expectAuthParkedFor(ALICE, q);
    expect(q.authLinksFor(ALICE).length).toBeGreaterThan(aliceLinksAfterConnect);

    await completeLatestMcpAuth({ userId: ALICE, agentRunner: q.agentRunner });
    expect(
      q.replies().some((text) =>
        text.includes("Reconnected after missing credentials"),
      ),
    ).toBe(true);
  });

  it("does not prompt another actor after prior MCP use on an unrelated request", async () => {
    const q = await createConversationWorkSlackHarness({
      modelStream: streamMcpSearch("Eval Auth is connected."),
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
    await expectMcpAuthCleared();
    expect(q.replies().at(-1)).toContain("Deploy looks fine.");
    await expect(
      getMcpStoredOAuthCredentials(BOB, EVAL_MCP_AUTH_PROVIDER),
    ).resolves.toBeUndefined();
  });

  it("prompts only the new actor when that actor intentionally uses MCP", async () => {
    const q = await createConversationWorkSlackHarness({
      modelStream: streamMcpSearch("Eval Auth is connected."),
    });
    await connectActor(q, ALICE);
    const aliceLinksAfterConnect = q.authLinksFor(ALICE).length;

    q.setModelStream(streamMcpSearch("Bob is connected."));
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
      modelStream: streamMcpSearch("Eval Auth is connected."),
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
    await expectMcpAuthCleared();
    await expect(
      getMcpStoredOAuthCredentials(BOB, EVAL_MCP_AUTH_PROVIDER),
    ).resolves.toBeUndefined();

    // Alice continues under her own connection; Bob never becomes credential authority.
    q.setModelStream(streamMcpSearch("Record 42 noted under Alice."));
    await q.mention(ALICE, "continue with the record id from the thread");
    await q.drain();

    expectNoAuthFor(BOB, q);
    expect(q.authLinksFor(ALICE)).toHaveLength(aliceLinksAfterConnect);
    expect(
      q.replies().some((text) => text.includes("Record 42 noted under Alice")),
    ).toBe(true);
  });

  it("does not request auth again when the same person cancels with a later message", async () => {
    const q = await createConversationWorkSlackHarness({
      modelStream: streamMcpSearch("Eval Auth is connected."),
    });
    await q.mention(ALICE, "use eval-auth and confirm the connection");
    await q.drain();
    await expectAuthParkedFor(ALICE, q);
    const aliceLinksWhilePending = q.authLinksFor(ALICE).length;

    // Alice never completes the link. A later plain request must answer without
    // another auth prompt.
    q.setModelStream(streamScript("Okay, never mind."));
    await q.mention(ALICE, "never mind");
    await q.drain();

    expect(q.authLinksFor(ALICE)).toHaveLength(aliceLinksWhilePending);
    expect(q.replies().at(-1)).toContain("Okay, never mind.");
    expect(q.replies().filter((text) => AUTH_NOTICE.test(text))).toHaveLength(1);
  });

  it("does not hand pending MCP auth to a passive bystander while the owner waits", async () => {
    const q = await createConversationWorkSlackHarness({
      modelStream: streamMcpSearch("Eval Auth is connected."),
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

    await completeLatestMcpAuth({ userId: ALICE, agentRunner: q.agentRunner });
    await expectMcpAuthCleared();
    await expect(
      getMcpStoredOAuthCredentials(BOB, EVAL_MCP_AUTH_PROVIDER),
    ).resolves.toBeUndefined();
    expect(
      q.replies().some((text) => text.includes("Eval Auth is connected")),
    ).toBe(true);
  });

  it("does not restore another actor's MCP connection for a passive continuation reply", async () => {
    const q = await createConversationWorkSlackHarness({
      modelStream: streamMcpSearch("Eval Auth is connected."),
      subscribedShouldReply: true,
    });
    await connectActor(q, ALICE);

    // Subscribed follow-up from Bob continues the thread as Bob's turn.
    // Alice's prior MCP connection must not be restored under Bob.
    q.setModelStream(streamScript("Got the record id, thanks."));
    await q.passive(BOB, "the record id is 42");
    await q.drain();

    expectNoAuthFor(BOB, q);
    await expectMcpAuthCleared();
    expect(q.replies().at(-1)).toContain("Got the record id");
    await expect(
      getMcpStoredOAuthCredentials(BOB, EVAL_MCP_AUTH_PROVIDER),
    ).resolves.toBeUndefined();
  });

  it("does not restore another actor's MCP provider when this actor uses a different one", async () => {
    const q = await createConversationWorkSlackHarness({
      modelStream: streamMcpSearch("Eval Auth is connected."),
    });
    // Alice owns Eval Auth in this thread.
    await connectActor(q, ALICE);
    const aliceLinksAfterConnect = q.authLinksFor(ALICE).length;

    // Bob intentionally uses a different MCP provider. Shared thread history
    // still shows Alice's Eval Auth use, but Bob must not inherit it or get
    // an Eval Auth prompt while connecting his own provider.
    q.setModelStream(streamOpenMcpSearch("Open handbook lookup done."));
    await q.mention(BOB, "use eval-mcp-open for the handbook lookup");
    await q.drain();

    expectNoAuthFor(BOB, q);
    expect(q.authLinksFor(ALICE)).toHaveLength(aliceLinksAfterConnect);
    await expectMcpAuthCleared();
    expect(
      q.replies().some((text) => text.includes("Open handbook lookup done")),
    ).toBe(true);
    await expect(
      getMcpStoredOAuthCredentials(BOB, EVAL_MCP_AUTH_PROVIDER),
    ).resolves.toBeUndefined();
  });

  it("does not restore another actor's MCP provider across OAuth resume for a different provider", async () => {
    const q = await createConversationWorkSlackHarness({
      modelStream: streamOpenMcpSearch("Open handbook is connected."),
    });
    // Alice first leaves open-MCP history in the thread (no auth).
    await q.mention(ALICE, "use eval-mcp-open and confirm");
    await q.drain();
    expect(
      q.replies().some((text) => text.includes("Open handbook is connected")),
    ).toBe(true);

    // Bob parks for Eval Auth. Resume must reconnect only Bob's provider,
    // not warm Alice's open MCP (or any other shared-history provider) under Bob.
    q.setModelStream(streamMcpSearch("Bob Eval Auth is connected."));
    await q.mention(BOB, "use eval-auth for my own lookup");
    await q.drain();
    await expectAuthParkedFor(BOB, q);

    await completeLatestMcpAuth({ userId: BOB, agentRunner: q.agentRunner });

    await expectMcpAuthCleared();
    expectNoAuthFor(ALICE, q);
    // Only Bob's Eval Auth auth notice — never a second auth from restore.
    expect(q.replies().filter((text) => AUTH_NOTICE.test(text))).toHaveLength(1);
    expect(
      q.replies().some((text) => text.includes("Bob Eval Auth is connected")),
    ).toBe(true);
    await expectMcpAuthCredentialsStored(BOB);
  });
});
