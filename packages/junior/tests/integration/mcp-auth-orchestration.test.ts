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
import { listTurnSummaries } from "@/chat/task-execution/checkpoint";
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
const THREAD_TS = "1712345.0001";
const AUTH_NOTICE = /I need access to Eval Auth to continue/;

type ScriptStep = string | { tool: string; args?: Record<string, unknown> };

/**
 * Queue model steps and repeat the last reply for resume / follow-up model
 * calls in the same agent run.
 */
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
function streamMcpLoad(replyAfterConnect: string): StreamFn {
  return streamScript(
    { tool: "loadSkill", args: { skill_name: EVAL_MCP_AUTH_PROVIDER } },
    replyAfterConnect,
  );
}

/**
 * Compose the same ingress, runtime, worker, resume, SQL, and delivery path
 * used in production. Fake only model generation and Slack I/O.
 */
async function slack(options: { modelStream: StreamFn }) {
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
    services: { replyExecutor: { agentRunner } },
    state,
  });

  let messageSeq = 0;
  const nextTs = () => {
    messageSeq += 1;
    return `1712345.${String(messageSeq).padStart(4, "0")}`;
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
    authLinksFor: (userId: string) =>
      getCapturedSlackApiCalls("chat.postEphemeral").filter(
        (call) => String(call.params.user ?? "") === userId,
      ),
    next: async () =>
      await processConversationQueueMessage(wakes.takeMessage(), {
        queue: wakes,
        run: work.run,
        state,
      }),
    mention: async (user: string, text: string) => {
      const ts = nextTs();
      await handleSlackWebhookAndFlush({
        request: slackWebhookRequest(
          slackEnvelope({
            eventType: "app_mention",
            text: `<@${SLACK_BOT_USER_ID}> ${text}`,
            threadTs: THREAD_TS,
            ts,
            user,
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
    },
  };
}

type QueueTest = Awaited<ReturnType<typeof slack>>;

async function drain(q: QueueTest): Promise<void> {
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
async function expectAuthParkedFor(userId: string, q: QueueTest) {
  expect(q.replies().some((text) => AUTH_NOTICE.test(text))).toBe(true);
  expect(q.authLinksFor(userId).length).toBeGreaterThan(0);
  expect((await conversationState()).processing.pendingAuth).toMatchObject({
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
async function connectAlice(q: QueueTest): Promise<void> {
  await q.mention(ALICE, "use eval-auth and confirm the connection");
  await drain(q);
  await expectAuthParkedFor(ALICE, q);
  await completeAuth(ALICE, q.agentRunner);
  expect((await conversationState()).processing.pendingAuth).toBeUndefined();
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
    const q = await slack({
      modelStream: streamMcpLoad("Eval Auth is connected."),
    });

    await connectAlice(q);
    const aliceLinksAfterConnect = q.authLinksFor(ALICE).length;

    q.setModelStream(streamMcpLoad("Connection still works."));
    await q.mention(ALICE, "use eval-auth again");
    await drain(q);

    expect(q.authLinksFor(ALICE)).toHaveLength(aliceLinksAfterConnect);
    expect((await conversationState()).processing.pendingAuth).toBeUndefined();
    expect(
      q.replies().some((text) => text.includes("Connection still works")),
    ).toBe(true);
  });

  it("does not prompt another actor after prior MCP use on an unrelated request", async () => {
    const q = await slack({
      modelStream: streamMcpLoad("Eval Auth is connected."),
    });
    await connectAlice(q);

    q.setModelStream(streamScript("Deploy looks fine."));
    await q.mention(BOB, "what is the deploy status?");
    await drain(q);

    // Prior Alice MCP use must not force Bob to authorize an unused provider.
    expect(q.authLinksFor(BOB)).toEqual([]);
    expect(q.replies().some((text) => AUTH_NOTICE.test(text))).toBe(false);
    expect((await conversationState()).processing.pendingAuth).toBeUndefined();
    expect(q.replies().at(-1)).toContain("Deploy looks fine.");
  });

  it("prompts only the new actor when that actor intentionally uses MCP", async () => {
    const q = await slack({
      modelStream: streamMcpLoad("Eval Auth is connected."),
    });
    await connectAlice(q);
    const aliceLinksAfterConnect = q.authLinksFor(ALICE).length;

    q.setModelStream(streamMcpLoad("Bob is connected."));
    await q.mention(BOB, "use eval-auth for my own lookup");
    await drain(q);

    await expectAuthParkedFor(BOB, q);
    expect(q.authLinksFor(ALICE)).toHaveLength(aliceLinksAfterConnect);
    const bobCredentials = await getMcpStoredOAuthCredentials(
      BOB,
      EVAL_MCP_AUTH_PROVIDER,
    );
    expect(bobCredentials?.tokens?.access_token).toBeUndefined();
  });
});
