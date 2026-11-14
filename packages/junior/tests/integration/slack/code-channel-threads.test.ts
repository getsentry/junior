import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRun } from "@/chat/agent/types";
import { listUnreportedSiblingAgents } from "@/chat/agent-invocations/list";
import { bindMessageAgent } from "@/chat/agent-invocations/message";
import { bindSpawnAgent } from "@/chat/agent-invocations/spawn";
import { getConversationStoppedAtMs } from "@/chat/conversations/session-stop";
import { getConversationStore, getDb } from "@/chat/db";
import { juniorConversations } from "@/db/schema";
import { eq } from "drizzle-orm";
import { setExperimentalFeatures } from "@/chat/experimental";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { deliverAssistantMessagesForTest } from "../../fixtures/agent-runner";
import {
  createConversationWorkHarness,
  handleSlackWebhookAndFlush,
  SLACK_BOT_USER_ID,
  slackEnvelope,
  slackWebhookRequest,
  THREAD_TS,
} from "../../fixtures/conversation-work";
import { SUITE_EXPERIMENTAL } from "../../fixtures/experimental-setup";
import { slackApiOutbox } from "../../fixtures/slack-api-outbox";
import { conversationsInfoOk } from "../../fixtures/slack/factories/api";
import { mockTitleModel } from "../../fixtures/title-model";
import {
  queueSlackApiError,
  queueSlackApiResponse,
} from "../../msw/handlers/slack-api";

const CODE_CHANNEL = "C0CODE001";
const TASK = "Fix the flaky deploy check.";
const PARENT_NOTE = "Draft PR is up.";

/** What the scripted agent does in the current test. */
const scenario: { rootKind: "task" | "thread"; childSpawns: boolean } = {
  rootKind: "thread",
  childSpawns: false,
};

type Harness = Awaited<ReturnType<typeof startHarness>>;

/**
 * Compose production Slack ingress and Conversation work. Integration tests
 * do not run the agent. This runner reads each run, makes the agent tool
 * calls and the delivery that a model would make for it, and stops the run.
 * A root spawns one child. A Thread's first Turn messages its parent and
 * answers in its channel.
 */
async function startHarness() {
  const runs: AgentRun[] = [];
  let work: Awaited<ReturnType<typeof createConversationWorkHarness>>;
  const tools = (run: AgentRun) => ({
    messageAgent: bindMessageAgent(run, { queue: work.queue })!,
    spawnAgent: bindSpawnAgent(run, { queue: work.queue, state: work.state })!,
  });
  work = await createConversationWorkHarness({
    run: async (run) => {
      runs.push(run);
      const isRoot = run.conversationId.startsWith("slack:");
      if (isRoot && run.instruction.text.includes("fix the deploy check")) {
        await tools(run).spawnAgent(
          { kind: scenario.rootKind, task: TASK, title: "Flaky deploy" },
          { toolCallId: "spawn" },
        );
      }
      if (!isRoot && run.instruction.text.includes(TASK)) {
        if (scenario.childSpawns) {
          await tools(run).spawnAgent(
            { kind: "thread", task: "Split off the retry work." },
            { toolCallId: "nested-spawn" },
          );
        } else {
          await tools(run).messageAgent(
            { to: "parent", text: PARENT_NOTE },
            { toolCallId: "note" },
          );
          await deliverAssistantMessagesForTest(run, [
            { text: "Looking into the flaky check here." },
          ]);
        }
      }
      throw new Error("stop after reading the run");
    },
  });
  const services = {
    getSlackAdapter: () => work.adapter,
    queue: work.queue,
    runtime: work.runtime,
    state: work.state,
  };
  /** Deliver one raw Slack event through webhook ingress. */
  const sendEvent = async (event: Record<string, unknown>) =>
    await handleSlackWebhookAndFlush({
      request: slackWebhookRequest({
        type: "event_callback",
        team_id: "T123",
        event_id: `Ev_${String(event.type)}_${String(event.ts ?? event.event_ts)}`,
        event,
      }),
      services,
    });
  return {
    /** Run the next queued wake of one Conversation, as the queue does. */
    process: async (conversationId: string) =>
      await work.process(work.queue.takeMessageFor(conversationId)),
    queue: work.queue,
    runs,
    send: async (input: Parameters<typeof slackEnvelope>[0]) =>
      await handleSlackWebhookAndFlush({
        request: slackWebhookRequest(slackEnvelope(input)),
        services,
      }),
    sendEvent,
    sendSessionStop: async (input: {
      channel?: string;
      eventTs: string;
      threadTs?: string;
    }) =>
      await sendEvent({
        type: "agent_session_stopped",
        channel: input.channel ?? "C123",
        event_ts: input.eventTs,
        streaming_message_ts: [],
        ...(input.threadTs ? { thread_ts: input.threadTs } : undefined),
        user: "U123",
      }),
    state: work.state,
  };
}

/**
 * A person asks the root for work in Slack, and the root's Turn spawns a
 * child. Then the child's first Turn runs once.
 */
async function startChannelThread(input: { channel?: string } = {}) {
  vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
  const harness = await startHarness();
  await harness.send({
    ...input,
    text: `<@${SLACK_BOT_USER_ID}> fix the deploy check`,
  });
  const rootId = harness.queue.queuedMessages()[0]!.conversationId;
  await harness.process(rootId);
  const [child] = await getDb()
    .select({ conversationId: juniorConversations.conversationId })
    .from(juniorConversations)
    .where(eq(juniorConversations.parentConversationId, rootId));
  const threadId = child?.conversationId;
  if (
    threadId &&
    harness.queue.queuedMessages().some((m) => m.conversationId === threadId)
  ) {
    await harness.process(threadId);
  }
  return { harness, rootId, threadId: threadId ?? "" };
}

/** The texts of the Event messages, such as Agent messages, in a mailbox. */
async function eventTexts(conversationId: string, harness: Harness) {
  const work = await getConversationWorkState({
    conversationId,
    state: harness.state,
  });
  return (
    work?.messages
      .filter((message) => message.source === "event")
      .map((message) => message.input.text) ?? []
  );
}

function codeChannelPosts() {
  return slackApiOutbox
    .messages()
    .filter((call) => call.params.channel === CODE_CHANNEL);
}

function archiveEvent() {
  return {
    type: "message",
    subtype: "channel_archive",
    channel: CODE_CHANNEL,
    user: "U123",
    ts: "1712345.0200",
  };
}

describe("Slack code channel Threads", () => {
  beforeEach(() => {
    setExperimentalFeatures({ ...SUITE_EXPERIMENTAL, "code-channels": true });
    mockTitleModel("Flaky deploy");
  });

  afterEach(async () => {
    vi.useRealTimers();
    scenario.rootKind = "thread";
    scenario.childSpawns = false;
    setExperimentalFeatures(SUITE_EXPERIMENTAL);
    await disconnectStateAdapter();
  });

  it("opens a code channel for a Thread and works there as a root", async () => {
    const { harness, rootId, threadId } = await startChannelThread();

    expect(
      slackApiOutbox.calls("agents.conversations.create")[0]?.params,
    ).toMatchObject({
      origin_channel_id: "C123",
      origin_message_ts: THREAD_TS,
      session_id: threadId,
    });
    await expect(
      getConversationStore().get({ conversationId: threadId }),
    ).resolves.toMatchObject({
      kind: "thread",
      location: { channelId: CODE_CHANNEL, provider: "slack" },
      parentConversationId: rootId,
    });
    // The Thread's parent task ran at the top level of its channel.
    expect(harness.runs.at(-1)).toMatchObject({
      conversationId: threadId,
      location: { channelId: CODE_CHANNEL },
    });
    expect(harness.runs.at(-1)?.location).not.toHaveProperty("threadTs");
    const posts = codeChannelPosts();
    expect(posts[0]?.params.text).toBe("Looking into the flaky check here.");
    expect(posts[0]?.params.thread_ts).toBeUndefined();
    expect(
      slackApiOutbox.calls("agents.sessions.setStatus")[0]?.params,
    ).toMatchObject({ channel_id: CODE_CHANNEL, status: "processing" });
    // Nothing waits for a channel Thread.
    await expect(
      listUnreportedSiblingAgents(rootId, "none", []),
    ).resolves.toEqual([]);

    // A person's message in the code channel is input to the Thread, with
    // no mention and with passive routing off.
    await harness.send({
      channel: CODE_CHANNEL,
      eventType: "message",
      text: "also check the retry",
      ts: "1712345.0100",
    });
    const runCount = harness.runs.length;
    while (harness.runs.length === runCount) {
      await harness.process(threadId);
    }
    expect(harness.runs.at(-1)).toMatchObject({
      conversationId: threadId,
      instruction: { text: expect.stringContaining("also check the retry") },
      source: { kind: "slack", channelId: CODE_CHANNEL },
    });
  });

  it("sends the parent only messageAgent texts and one wrap-up", async () => {
    const { harness, rootId } = await startChannelThread();
    // The Thread's Turn failed after it messaged its parent. The failure
    // stays in the code channel: the parent has only the message.
    for (let i = 0; i < 6; i++) {
      if (
        !harness.queue.queuedMessages().some((m) => m.conversationId !== rootId)
      ) {
        break;
      }
      const next = harness.queue
        .queuedMessages()
        .find((m) => m.conversationId !== rootId)!;
      await harness.process(next.conversationId);
    }
    const before = await eventTexts(rootId, harness);
    expect(before).toHaveLength(1);
    expect(before[0]).toContain(PARENT_NOTE);

    await harness.sendEvent(archiveEvent());
    // A redelivered archive event sends no second wrap-up.
    await harness.sendEvent(archiveEvent());
    const after = await eventTexts(rootId, harness);
    expect(after).toHaveLength(2);
    expect(after[1]).toContain("Its code channel was archived");
    expect(after[1]).toContain("It already sent you messages");
  });

  it("stops in the code channel without an ack, and an origin stop leaves it", async () => {
    const { harness, threadId } = await startChannelThread();

    await harness.sendSessionStop({ eventTs: "1712345.0300" });
    await expect(getConversationStoppedAtMs(threadId)).resolves.toBe(undefined);

    const statusCalls = slackApiOutbox.calls("agents.sessions.setStatus");
    const posts = codeChannelPosts().length;
    // A stop in a Slack thread inside the code channel stops the Thread.
    await harness.sendSessionStop({
      channel: CODE_CHANNEL,
      eventTs: "1712345.0400",
      threadTs: "1712345.0390",
    });
    await expect(getConversationStoppedAtMs(threadId)).resolves.toBeDefined();
    expect(codeChannelPosts()).toHaveLength(posts);
    expect(slackApiOutbox.calls("agents.sessions.setStatus")).toHaveLength(
      statusCalls.length,
    );
  });

  it("keeps a plain Thread when Slack refuses the code channel", async () => {
    queueSlackApiError("agents.conversations.create", {
      error: "feature_disabled",
    });
    const { threadId } = await startChannelThread();

    await expect(
      getConversationStore().get({ conversationId: threadId }),
    ).resolves.toMatchObject({
      kind: "thread",
      location: { channelId: "C123", threadTs: THREAD_TS },
    });
    expect(codeChannelPosts()).toEqual([]);
    expect(
      slackApiOutbox
        .messages()
        .map((call) => String(call.params.text))
        .filter((text) => text.includes("feature_disabled")),
    ).toEqual([]);
  });

  it.each([
    ["a Task", () => (scenario.rootKind = "task")],
    [
      "an origin that turned private",
      () => {
        // The first lookup serves ingress. The live check before create
        // sees the channel as private now.
        queueSlackApiResponse("conversations.info", {
          body: conversationsInfoOk(),
        });
        queueSlackApiResponse("conversations.info", {
          body: conversationsInfoOk({ isPrivate: true }),
        });
      },
    ],
  ])("opens no code channel for %s", async (_name, arrange) => {
    arrange();
    const { threadId } = await startChannelThread();
    expect(threadId).not.toBe("");
    expect(slackApiOutbox.calls("agents.conversations.create")).toEqual([]);
  });

  it("opens no code channel for a Thread below a channel Thread", async () => {
    scenario.childSpawns = true;
    const { threadId } = await startChannelThread();
    await expect(
      getDb()
        .select({ conversationId: juniorConversations.conversationId })
        .from(juniorConversations)
        .where(eq(juniorConversations.parentConversationId, threadId)),
    ).resolves.toHaveLength(1);
    // Only the root's Thread got a code channel.
    expect(slackApiOutbox.calls("agents.conversations.create")).toHaveLength(1);
  });

  it("opens no code channel from a mention in an unbound code channel", async () => {
    // People can open code channels from Slack's own UI. Junior does not
    // own those, so a mention there runs a plain root Turn.
    const unbound = "C0UNBOUND";
    const ok = conversationsInfoOk({ channelId: unbound });
    const info = {
      body: {
        ...ok,
        channel: {
          ...ok.channel,
          properties: { record_channel: { record_type: "agent_channel" } },
        },
      },
    };
    queueSlackApiResponse("conversations.info", info);
    queueSlackApiResponse("conversations.info", info);
    const { rootId, threadId } = await startChannelThread({
      channel: unbound,
    });
    expect(rootId).toContain(unbound);
    expect(threadId).not.toBe("");
    expect(slackApiOutbox.calls("agents.conversations.create")).toEqual([]);
  });

  it("keeps one open channel Thread for each origin Slack thread", async () => {
    const { harness, rootId, threadId } = await startChannelThread();
    await harness.send({
      text: `<@${SLACK_BOT_USER_ID}> fix the deploy check, again`,
      threadTs: THREAD_TS,
      ts: "1712345.0500",
    });
    const runCount = harness.runs.length;
    while (harness.runs.length === runCount) {
      await harness.process(rootId);
    }
    expect(slackApiOutbox.calls("agents.conversations.create")).toHaveLength(1);
    // The second task waits for the open Thread as a message from its
    // parent.
    await expect(
      getDb()
        .select({ conversationId: juniorConversations.conversationId })
        .from(juniorConversations)
        .where(eq(juniorConversations.parentConversationId, rootId)),
    ).resolves.toEqual([{ conversationId: threadId }]);
    expect(
      (await eventTexts(threadId, harness)).filter((text) =>
        text.includes(TASK),
      ),
    ).toHaveLength(2);
  });

  it("starts no Turn for a bot post in the origin Slack thread", async () => {
    const { harness, rootId } = await startChannelThread();
    const queued = harness.queue
      .queuedMessages()
      .filter((m) => m.conversationId === rootId).length;
    // Slack's card for the new code channel, or any bot post, is not input.
    await harness.sendEvent({
      type: "message",
      subtype: "bot_message",
      bot_id: "B0SLACK",
      channel: "C123",
      thread_ts: THREAD_TS,
      text: "Junior opened a code channel",
      ts: "1712345.0600",
    });
    expect(
      harness.queue.queuedMessages().filter((m) => m.conversationId === rootId),
    ).toHaveLength(queued);
  });
});
