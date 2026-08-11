import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createConversationWork } from "@/chat/app/conversation-work";
import { executeAgentRun } from "@/chat/agent";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { getPersistedThreadState } from "@/chat/runtime/thread-state";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { hydrateConversationMessages } from "@/chat/conversations/messages";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { getConversationStore } from "@/chat/db";
import {
  getTurnRecord,
  listTurnSummaries,
} from "@/chat/task-execution/checkpoint";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import {
  getLatestMcpAuthSessionForUserProvider,
  getMcpStoredOAuthCredentials,
} from "@/chat/mcp/auth-store";
import {
  CONVERSATION_ID,
  createConversationWorkQueueTestAdapter,
  createSlackAdapterFixture,
  handleSlackWebhookAndFlush,
  SLACK_BOT_USER_ID,
  slackEnvelope,
  slackWebhookRequest,
} from "../fixtures/conversation-work";
import { completeMcpOauthCallbackRoute } from "../fixtures/mcp-oauth-callback-harness";
import {
  createPluginAppFixture,
  type PluginAppFixture,
} from "../fixtures/plugin-app";
import { slackApiOutbox } from "../fixtures/slack-api-outbox";
import { EVAL_MCP_AUTH_PROVIDER } from "../msw/handlers/eval-mcp-auth";
import {
  getCapturedSlackApiCalls,
  resetSlackApiMockState,
} from "../msw/handlers/slack-api";

/**
 * Actor-scoped MCP auth UX through the durable queue.
 * See https://github.com/getsentry/junior/issues/1377
 *
 * Drive live Slack ingress → worker → real agent → real MCP/OAuth fixtures.
 * Fake only the model stream and Slack HTTP.
 */

const ORIGINAL_ENV = { ...process.env };
const EVAL_MCP_PLUGIN_ROOT = path.resolve(
  import.meta.dirname,
  "../fixtures/plugins/eval-auth",
);
const ALICE = "UALICE";
const BOB = "UBOB";
const THREAD_TS = "1712345.0001";
const AUTH_NOTICE = /I need access to Eval Auth to continue/;

type ScriptStep =
  | string
  | { tool: string; args?: Record<string, unknown> };

/** Queue model steps. Loop the last reply for resume and follow-up turns. */
function streamScript(...steps: ScriptStep[]): StreamFn {
  const faux = createFauxCore({ api: "test", provider: "test" });
  const built = steps.map((step) => {
    if (typeof step === "string") {
      return fauxAssistantMessage(step);
    }
    return fauxAssistantMessage([fauxToolCall(step.tool, step.args ?? {})], {
      stopReason: "toolUse",
    });
  });
  const last = built.at(-1);
  if (!last) {
    throw new Error("streamScript requires at least one step");
  }
  faux.setResponses([...built, ...Array.from({ length: 12 }, () => last)]);
  return faux.stream;
}

/** loadSkill activates the MCP provider; missing credentials park for auth. */
function mcpLoadSkillStream(replyAfterConnect: string): StreamFn {
  return streamScript(
    { tool: "loadSkill", args: { skill_name: EVAL_MCP_AUTH_PROVIDER } },
    replyAfterConnect,
  );
}

function plainReplies(...texts: string[]): StreamFn {
  return streamScript(...texts);
}

async function createHarness(options: {
  modelStream: StreamFn;
  subscribedShouldReply?: boolean;
}) {
  const state = getStateAdapter();
  await state.connect();
  const wakes = createConversationWorkQueueTestAdapter();
  const adapter = createSlackAdapterFixture();
  let modelStream = options.modelStream;
  const agentRunner: AgentRunner = {
    run: async (request) => await executeAgentRun(request, modelStream),
  };
  const work = createConversationWork({
    agentRunner,
    conversationStore: getConversationStore(),
    getSlackAdapter: () => adapter,
    queue: wakes,
    services: {
      replyExecutor: { agentRunner },
      subscribedReplyPolicy: {
        completeObject: async ({ schema }) => ({
          object: schema.parse({
            should_reply: options.subscribedShouldReply ?? true,
            should_unsubscribe: false,
            confidence: 1,
            reason: "test_follow_up",
          }),
        }),
      },
      visionContext: {
        listThreadReplies: async () => [],
      },
    },
    state,
  });

  let messageSeq = 0;
  const nextTs = () => {
    messageSeq += 1;
    return `1712345.${String(messageSeq).padStart(4, "0")}`;
  };

  const send = async (input: {
    user: string;
    text: string;
    mention?: boolean;
  }) => {
    const ts = nextTs();
    const mention = input.mention ?? true;
    await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({
          eventType: mention ? "app_mention" : "message",
          text: mention
            ? `<@${SLACK_BOT_USER_ID}> ${input.text}`
            : input.text,
          threadTs: THREAD_TS,
          ts,
          user: input.user,
        }),
      ),
      services: {
        getSlackAdapter: () => adapter,
        queue: wakes,
        runtime: work.runtime,
        state,
      },
    });
    return ts;
  };

  return {
    agentRunner,
    wakes,
    setModelStream(next: StreamFn) {
      modelStream = next;
    },
    replies: () =>
      slackApiOutbox
        .messages()
        .map((call) => call.params.text)
        .filter((text): text is string => typeof text === "string"),
    authLinks: () =>
      getCapturedSlackApiCalls("chat.postEphemeral").map((call) => ({
        user: String(call.params.user ?? ""),
        text: String(call.params.text ?? ""),
      })),
    next: async () =>
      await processConversationQueueMessage(wakes.takeMessage(), {
        queue: wakes,
        run: work.run,
        state,
      }),
    mention: async (user: string, text: string) =>
      await send({ user, text, mention: true }),
    passive: async (user: string, text: string) =>
      await send({ user, text, mention: false }),
  };
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

async function drain(q: Harness): Promise<void> {
  for (let i = 0; i < 12 && q.wakes.hasQueuedMessages(); i += 1) {
    await q.next();
  }
  if (q.wakes.hasQueuedMessages()) {
    throw new Error("queue still has work after drain");
  }
}

async function conversationState() {
  const conversation = coerceThreadConversationState(
    await getPersistedThreadState(CONVERSATION_ID),
  );
  await hydrateConversationMessages({
    conversation,
    conversationId: CONVERSATION_ID,
  });
  return conversation;
}

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

async function expectPausedFor(userId: string, q: Harness) {
  const conversation = await conversationState();
  expect(conversation.processing.pendingAuth).toMatchObject({
    kind: "mcp",
    provider: EVAL_MCP_AUTH_PROVIDER,
    actorId: userId,
  });
  const paused = (await listTurnSummaries(CONVERSATION_ID)).find(
    (turn) => turn.state === "paused" && turn.resumeReason === "auth",
  );
  expect(paused).toMatchObject({
    state: "paused",
    resumeReason: "auth",
  });
  expect(q.replies().some((text) => AUTH_NOTICE.test(text))).toBe(true);
  const links = q.authLinks().filter((link) => link.user === userId);
  expect(links.length).toBeGreaterThan(0);
  return paused!.turnId;
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

  it("parks first MCP use for the requesting actor, then resumes after OAuth", async () => {
    const q = await createHarness({
      modelStream: mcpLoadSkillStream("Eval Auth is connected."),
    });

    await q.mention(ALICE, "use eval-auth and confirm the connection");
    await drain(q);
    const turnId = await expectPausedFor(ALICE, q);

    await completeAuth(ALICE, q.agentRunner);

    await expect(getTurnRecord(CONVERSATION_ID, turnId)).resolves.toMatchObject(
      { state: "completed", turnId },
    );
    await expect(
      getMcpStoredOAuthCredentials(ALICE, EVAL_MCP_AUTH_PROVIDER),
    ).resolves.toMatchObject({
      tokens: expect.objectContaining({ access_token: expect.any(String) }),
    });
    expect((await conversationState()).processing.pendingAuth).toBeUndefined();
    expect(
      q.replies().some((text) => text.includes("Eval Auth is connected")),
    ).toBe(true);
  });

  it("reuses the same actor's MCP connection on a later turn without another prompt", async () => {
    const q = await createHarness({
      modelStream: mcpLoadSkillStream("Eval Auth is connected."),
    });

    await q.mention(ALICE, "use eval-auth and confirm the connection");
    await drain(q);
    await expectPausedFor(ALICE, q);
    await completeAuth(ALICE, q.agentRunner);
    const authLinkCount = q.authLinks().length;

    q.setModelStream(mcpLoadSkillStream("Connection still works."));
    await q.mention(ALICE, "use eval-auth again");
    await drain(q);

    expect(q.authLinks()).toHaveLength(authLinkCount);
    expect((await conversationState()).processing.pendingAuth).toBeUndefined();
    expect(
      q.replies().some((text) => text.includes("Connection still works")),
    ).toBe(true);
  });

  it("does not prompt another actor for MCP auth on an unrelated request", async () => {
    const q = await createHarness({
      modelStream: mcpLoadSkillStream("Eval Auth is connected."),
    });
    await q.mention(ALICE, "use eval-auth and confirm the connection");
    await drain(q);
    await expectPausedFor(ALICE, q);
    await completeAuth(ALICE, q.agentRunner);

    q.setModelStream(plainReplies("Deploy looks fine."));
    await q.mention(BOB, "what is the deploy status?");
    await drain(q);

    // Bob never asked for Eval Auth. Prior Alice MCP use must not force Bob to auth.
    expect(q.authLinks().filter((link) => link.user === BOB)).toEqual([]);
    expect((await conversationState()).processing.pendingAuth).toBeUndefined();
    expect(q.replies().at(-1)).toContain("Deploy looks fine.");
    await expect(
      getMcpStoredOAuthCredentials(BOB, EVAL_MCP_AUTH_PROVIDER),
    ).resolves.toBeUndefined();
  });

  it("prompts only the new actor when that actor intentionally uses MCP", async () => {
    const q = await createHarness({
      modelStream: mcpLoadSkillStream("Eval Auth is connected."),
    });
    await q.mention(ALICE, "use eval-auth and confirm the connection");
    await drain(q);
    await expectPausedFor(ALICE, q);
    await completeAuth(ALICE, q.agentRunner);

    q.setModelStream(mcpLoadSkillStream("Bob is connected."));
    await q.mention(BOB, "use eval-auth for my own lookup");
    await drain(q);

    // Intentional MCP use by Bob must auth Bob, never Alice again and never
    // reuse Alice credentials under Bob.
    await expectPausedFor(BOB, q);
    expect(q.authLinks().filter((link) => link.user === ALICE)).toHaveLength(1);
    expect(q.authLinks().filter((link) => link.user === BOB).length).toBeGreaterThan(
      0,
    );
    await expect(
      getMcpStoredOAuthCredentials(ALICE, EVAL_MCP_AUTH_PROVIDER),
    ).resolves.toMatchObject({
      tokens: expect.objectContaining({ access_token: expect.any(String) }),
    });
    const bobCredentials = await getMcpStoredOAuthCredentials(
      BOB,
      EVAL_MCP_AUTH_PROVIDER,
    );
    expect(bobCredentials?.tokens?.access_token).toBeUndefined();
  });

  it("keeps Alice as credential authority when Bob passively supplies context after her turn", async () => {
    const q = await createHarness({
      modelStream: mcpLoadSkillStream("Need the record id before I continue."),
      subscribedShouldReply: true,
    });
    await q.mention(
      ALICE,
      "use eval-auth and continue when someone supplies the record id",
    );
    await drain(q);
    await expectPausedFor(ALICE, q);
    await completeAuth(ALICE, q.agentRunner);

    q.setModelStream(plainReplies("Record 42 noted under Alice's task."));
    await q.passive(BOB, "the record id is 42");
    await drain(q);

    // Passive Bob context must not flip credential authority or prompt Bob.
    expect(q.authLinks().filter((link) => link.user === BOB)).toEqual([]);
    expect((await conversationState()).processing.pendingAuth).toBeUndefined();
    expect(q.replies().at(-1)).toContain("Record 42");
    await expect(
      getMcpStoredOAuthCredentials(BOB, EVAL_MCP_AUTH_PROVIDER),
    ).resolves.toBeUndefined();
  });

  it("does not hand Alice's pending MCP auth to Bob when Bob replies while she is waiting", async () => {
    const q = await createHarness({
      modelStream: mcpLoadSkillStream("Eval Auth is connected."),
      subscribedShouldReply: true,
    });
    await q.mention(ALICE, "use eval-auth and confirm the connection");
    await drain(q);
    const turnId = await expectPausedFor(ALICE, q);

    q.setModelStream(plainReplies("should not replace Alice auth"));
    await q.passive(BOB, "while you wait, the id is 99");
    if (q.wakes.hasQueuedMessages()) {
      await drain(q);
    }

    // Bob's passive reply must stay context. Alice remains the pending auth owner.
    const conversation = await conversationState();
    expect(conversation.processing.pendingAuth).toMatchObject({
      kind: "mcp",
      provider: EVAL_MCP_AUTH_PROVIDER,
      actorId: ALICE,
      sessionId: turnId,
    });
    expect(q.authLinks().filter((link) => link.user === BOB)).toEqual([]);
    expect(q.authLinks().every((link) => link.user === ALICE)).toBe(true);
    await expect(getTurnRecord(CONVERSATION_ID, turnId)).resolves.toMatchObject({
      state: "paused",
      resumeReason: "auth",
      turnId,
    });

    await completeAuth(ALICE, q.agentRunner);
    await expect(getTurnRecord(CONVERSATION_ID, turnId)).resolves.toMatchObject({
      state: "completed",
      turnId,
    });
    await expect(
      getMcpStoredOAuthCredentials(BOB, EVAL_MCP_AUTH_PROVIDER),
    ).resolves.toBeUndefined();
  });
});
