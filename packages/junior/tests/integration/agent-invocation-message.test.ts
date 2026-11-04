import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindMessageAgent } from "@/chat/agent-invocations/message";
import {
  completeAgentInvocation,
  createAgentInvocation,
  getAgentInvocation,
  getAgentInvocationId,
  getAgentInvocationIdForMessage,
  markAgentInvocationRunning,
} from "@/chat/agent-invocations/store";
import type { AgentInvocation } from "@/chat/agent-invocations/types";
import type { AgentRun } from "@/chat/agent/types";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { getConversationStore, getDb } from "@/chat/db";
import { EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
import { resolveViewerUserFromSql } from "@/chat/plugins/viewer";
import {
  juniorConversationAnnotations,
  juniorConversationBriefs,
  juniorConversationParticipants,
  juniorConversations,
  juniorIdentities,
} from "@/db/schema";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import {
  getConversationWorkState,
  type InboundMessage,
} from "@/chat/task-execution/store";
import { createSearchAgentsTool } from "@/chat/tools/runtime/search-agents";
import { createSearchConversationEventsTool } from "@/chat/tools/search-conversation-events";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { createMessageAgentTool } from "@/chat/tools/runtime/message-agent";
import { stopChildAgentInvocations } from "@/chat/agent-invocations/stop";
import { neverRunAgentRunner } from "../fixtures/agent-runner";
import { conversationBriefFixture } from "../fixtures/conversation-brief";
import { createConversationWorkHarness } from "../fixtures/conversation-work";
import {
  prepareSlackParentConversation,
  slackDestination,
  slackInvocationInput,
  slackParentConversationId,
} from "../fixtures/agent-invocations";

const parentActor = slackInvocationInput.actor;

function parentRun(): AgentRun {
  return {
    actor: parentActor,
    conversationId: slackParentConversationId,
    destination: slackDestination,
    instruction: { text: "Coordinate the work." },
    source: createSlackSource({
      channelId: "C123",
      teamId: "T123",
      threadTs: "1712345.0001",
      visibility: "public",
    }),
    turnId: "parent-turn",
  };
}

/** Save one top-level Slack Conversation with its visibility. */
async function topLevelConversation(args: {
  channelId: string;
  teamId?: string;
  visibility: "private" | "public";
}): Promise<string> {
  const teamId = args.teamId ?? "T123";
  const conversationId = `slack:${args.channelId}:1712345.0001`;
  await getConversationStore().recordActivity({
    conversationId,
    destination: { channelId: args.channelId, platform: "slack", teamId },
    nowMs: 1_000,
    sessionSource: createSlackSource({
      channelId: args.channelId,
      teamId,
      threadTs: "1712345.0001",
      visibility: args.visibility,
    }),
    source: "slack",
    visibility: args.visibility,
  });
  return conversationId;
}

/** A Run of one top-level Conversation. */
function topLevelRun(
  conversationId: string,
  actor: AgentRun["actor"] = parentActor,
): AgentRun {
  return { ...parentRun(), actor, conversationId, turnId: "top-level-turn" };
}

/** The Run of one child agent invocation, as the invocation worker builds it. */
function childRun(invocation: AgentInvocation): AgentRun {
  return {
    actor: invocation.actor,
    conversationId: invocation.childConversationId,
    destination: invocation.destination,
    instruction: { text: invocation.input },
    runId: invocation.invocationId,
    source: invocation.source,
    turnId: `agent-invocation:${invocation.invocationId}`,
  };
}

/** Read the Event messages, such as agent messages, in one mailbox. */
async function eventMessages(
  conversationId: string,
): Promise<InboundMessage[]> {
  const work = await getConversationWorkState({
    conversationId,
    state: getStateAdapter(),
  });
  return work?.messages.filter((message) => message.source === "event") ?? [];
}

/**
 * Integration tests do not run the agent. This runner reads each run and
 * stops it, so the work retries.
 */
function readRunsAgentRunner() {
  const runs: AgentRun[] = [];
  return {
    agentRunner: {
      run: async (run: AgentRun): Promise<never> => {
        runs.push(run);
        throw new Error("stop after reading the run");
      },
    },
    runs,
  };
}

const PULL_REQUEST_KEY = "getsentry/junior#1591";

async function annotatePullRequest(conversationId: string): Promise<void> {
  await getDb()
    .insert(juniorConversationAnnotations)
    .values({
      annotation: {
        key: PULL_REQUEST_KEY,
        kind: "resource_link",
        label: "getsentry/junior#1591",
        url: "https://github.com/getsentry/junior/pull/1591",
      },
      conversationId,
      createdAt: new Date(1),
      key: PULL_REQUEST_KEY,
      kind: "resource_link",
      plugin: "github",
      updatedAt: new Date(1),
    });
}

describe("messageAgent", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
    vi.restoreAllMocks();
  });

  it("gives a busy child more work and lets a child message its parent", async () => {
    const { fixture } = await prepareSlackParentConversation();
    const parent = readRunsAgentRunner();
    const harness = await createConversationWorkHarness(parent.agentRunner);
    const { queue, state } = harness;
    const mailbox = async (conversationId: string) =>
      (await getConversationWorkState({ conversationId, state }))?.messages ??
      [];
    try {
      const child = await createAgentInvocation({
        ...slackInvocationInput,
        agentName: "researcher",
        modelProfile: "handoff",
        idempotencyKey: "message-child",
        parentToolCallId: "call-spawn",
      });
      const running = (await markAgentInvocationRunning(child.invocationId))!;

      // Parent to busy child: the message waits for the current work.
      const parentTool = createMessageAgentTool(
        bindMessageAgent(parentRun(), { queue, state })!,
      );
      const sendFromParent = async (to: string, toolCallId: string) =>
        await parentTool.execute!(
          { text: "Also check the retry path.", to },
          { toolCallId },
        );
      await expect(
        sendFromParent("researcher", "call-message"),
      ).resolves.toEqual({
        conversation_id: child.childConversationId,
        delivery: "queued",
      });
      // A replayed tool call, here by conversation id, queues no second
      // message.
      await expect(
        sendFromParent(child.childConversationId, "call-message"),
      ).resolves.toEqual({
        conversation_id: child.childConversationId,
        delivery: "queued",
      });
      expect(await mailbox(child.childConversationId)).toHaveLength(1);
      await expect(
        getAgentInvocation(
          getAgentInvocationId(
            slackParentConversationId,
            "parent-turn:call-message",
          ),
        ),
      ).resolves.toMatchObject({ modelProfile: "handoff" });
      await expect(sendFromParent("nobody", "call-unknown")).rejects.toThrow(
        /"nobody" is not "parent", a child agent/,
      );

      // Child to parent: the message wakes the parent as the child's Actor.
      const childTool = createMessageAgentTool(
        bindMessageAgent(childRun(running), { queue, state })!,
      );
      await expect(
        childTool.execute!(
          { text: "Found the bug in the retry path.", to: "parent" },
          { toolCallId: "call-to-parent" },
        ),
      ).resolves.toEqual({
        conversation_id: slackParentConversationId,
        delivery: "queued",
      });
      await childTool.execute!(
        { text: "Found the bug in the retry path.", to: "parent" },
        { toolCallId: "call-to-parent" },
      );
      const parentMessages = await mailbox(slackParentConversationId);
      expect(parentMessages).toHaveLength(1);
      expect(parentMessages[0]).toMatchObject({
        delivery: "defer",
        input: {
          metadata: {
            event: { eventType: "agent.message", namespace: "junior" },
            kind: "event",
          },
        },
        source: "event",
      });
      expect(parentMessages[0]!.input.text).toContain(
        "It is not a message from a person",
      );
      expect(parentMessages[0]!.input.text).toContain(
        "Found the bug in the retry path.",
      );
      // The parent Turn runs after the Event burst window.
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
      await harness.process(queue.takeMessageFor(slackParentConversationId));
      vi.mocked(Date.now).mockRestore();
      expect(parent.runs).toEqual([
        expect.objectContaining({ actor: parentActor }),
      ]);

      // The first work finishes. The queued message reports for both.
      await expect(
        completeAgentInvocation({
          invocationId: child.invocationId,
          result: "First pass done.",
          status: "completed",
        }),
      ).resolves.toMatchObject({ parentMailboxStatus: "replaced" });
      await expect(
        createSearchAgentsTool({ conversationId: slackParentConversationId })
          .execute!({}, {}),
      ).resolves.toMatchObject({
        agents: [
          {
            conversation_id: child.childConversationId,
            name: "researcher",
            status: "pending",
            task: "Also check the retry path.",
          },
        ],
      });
      // Filters keep the same rows. A miss returns no agent.
      const relatives = createSearchAgentsTool({
        conversationId: slackParentConversationId,
      });
      await expect(
        relatives.execute!({ query: "RETRY path" }, {}),
      ).resolves.toMatchObject({
        agents: [{ conversation_id: child.childConversationId }],
      });
      await expect(
        relatives.execute!({ query: "deploy" }, {}),
      ).resolves.toEqual({ agents: [] });
      await expect(
        relatives.execute!({ conversation_ids: ["slack:COTHER:1.0"] }, {}),
      ).resolves.toEqual({ agents: [] });
      await annotatePullRequest(child.childConversationId);
      await expect(
        relatives.execute!({ annotation: PULL_REQUEST_KEY }, {}),
      ).resolves.toMatchObject({
        agents: [{ conversation_id: child.childConversationId }],
      });
      await expect(
        relatives.execute!({ annotation: "getsentry/junior#2" }, {}),
      ).resolves.toEqual({ agents: [] });
    } finally {
      await fixture.close();
    }
  });

  it("starts a new agent invocation when a grandchild messages a child, even after a stop", async () => {
    const { fixture } = await prepareSlackParentConversation();
    const runner = readRunsAgentRunner();
    const harness = await createConversationWorkHarness(runner.agentRunner);
    const { queue, state } = harness;
    try {
      const child = await createAgentInvocation({
        ...slackInvocationInput,
        idempotencyKey: "nested-message-child",
      });
      const helper = await createAgentInvocation({
        ...slackInvocationInput,
        idempotencyKey: "nested-message-helper",
        parentConversationId: child.childConversationId,
      });
      const runningHelper = (await markAgentInvocationRunning(
        helper.invocationId,
      ))!;
      const helperTool = createMessageAgentTool(
        bindMessageAgent(childRun(runningHelper), { queue, state })!,
      );
      await helperTool.execute!(
        { text: "Halfway there.", to: "parent" },
        { toolCallId: "call-halfway" },
      );
      const messages = await eventMessages(child.childConversationId);
      expect(messages).toHaveLength(1);
      // A stop after the send does not drop the message.
      await stopChildAgentInvocations({
        childConversationId: helper.childConversationId,
        parentConversationId: child.childConversationId,
      });
      // The message starts and runs a new agent invocation on the child.
      await harness.process(queue.takeMessageFor(child.childConversationId));
      const started = await getAgentInvocation(
        getAgentInvocationIdForMessage(messages[0]!.inboundMessageId),
      );
      expect(started).toMatchObject({
        childConversationId: child.childConversationId,
        input: expect.stringContaining("Halfway there."),
        parentConversationId: slackParentConversationId,
        status: "running",
      });
      expect(runner.runs).toEqual([
        expect.objectContaining({ runId: started!.invocationId }),
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("drops a grandchild message when the tree of its parent is stopped", async () => {
    const { fixture } = await prepareSlackParentConversation();
    const harness = await createConversationWorkHarness(neverRunAgentRunner());
    const { queue, state } = harness;
    try {
      const child = await createAgentInvocation({
        ...slackInvocationInput,
        idempotencyKey: "stopped-tree-child",
      });
      const helper = await createAgentInvocation({
        ...slackInvocationInput,
        idempotencyKey: "stopped-tree-helper",
        parentConversationId: child.childConversationId,
      });
      const runningHelper = (await markAgentInvocationRunning(
        helper.invocationId,
      ))!;
      await createMessageAgentTool(
        bindMessageAgent(childRun(runningHelper), { queue, state })!,
      ).execute!(
        { text: "Late finding.", to: "parent" },
        { toolCallId: "call-late" },
      );
      // The child finishes while its helper is open, so its result is
      // `replaced`. Then the parent stops the whole child tree.
      await expect(
        completeAgentInvocation({
          invocationId: child.invocationId,
          result: "Waiting on the helper.",
          status: "completed",
        }),
      ).resolves.toMatchObject({ parentMailboxStatus: "replaced" });
      await stopChildAgentInvocations({
        childConversationId: child.childConversationId,
        parentConversationId: slackParentConversationId,
      });
      // The `replaced` result was never reported, so it is not a result.
      const { agents } = (await createSearchAgentsTool({
        conversationId: slackParentConversationId,
      }).execute!({}, {})) as { agents: Record<string, unknown>[] };
      expect(agents).toHaveLength(1);
      expect(agents[0]).toMatchObject({ status: "stopped" });
      expect(agents[0]).not.toHaveProperty("last_result");
      const messages = await eventMessages(child.childConversationId);
      expect(messages).toHaveLength(1);
      await expect(
        harness.process(queue.takeMessageFor(child.childConversationId)),
      ).resolves.toMatchObject({ status: "completed" });
      await expect(
        getAgentInvocation(
          getAgentInvocationIdForMessage(messages[0]!.inboundMessageId),
        ),
      ).resolves.toBeUndefined();
    } finally {
      await fixture.close();
    }
  });

  it("lets top-level agents message public agents and private agents that the person owns", async () => {
    const { fixture } = await prepareSlackParentConversation();
    const runner = readRunsAgentRunner();
    const harness = await createConversationWorkHarness(runner.agentRunner);
    const { queue, state } = harness;
    try {
      const publicTarget = await topLevelConversation({
        channelId: "CPUB",
        visibility: "public",
      });
      const otherWorkspace = await topLevelConversation({
        channelId: "CFAR",
        teamId: "T999",
        visibility: "public",
      });
      const privateSender = await topLevelConversation({
        channelId: "CPRIV1",
        visibility: "private",
      });
      const privateOwned = await topLevelConversation({
        channelId: "CPRIV2",
        visibility: "private",
      });
      const privateMember = await topLevelConversation({
        channelId: "CPRIV3",
        visibility: "private",
      });
      // The person behind the Slack Actor started one private target and is
      // only a member of another.
      const ana = await resolveViewerUserFromSql(getDb(), "ana@example.com");
      await getDb()
        .insert(juniorIdentities)
        .values({
          createdAt: new Date(1),
          id: "identity:T123:U123",
          kind: "user",
          provider: "slack",
          providerSubjectId: "U123",
          providerTenantId: "T123",
          updatedAt: new Date(1),
          userId: ana!.id,
        })
        .onConflictDoUpdate({
          target: juniorIdentities.id,
          set: { userId: ana!.id },
        });
      await getDb()
        .update(juniorConversations)
        .set({ actorIdentityId: "identity:T123:U123" })
        .where(eq(juniorConversations.conversationId, privateOwned));
      await getDb()
        .insert(juniorConversationParticipants)
        .values({
          lastMessageAt: new Date(1),
          rootConversationId: privateMember,
          userId: ana!.id,
        });
      // searchAgents applies the same rule as messageAgent.
      await getDb()
        .update(juniorConversations)
        .set({ title: "Classifier queue backlog" })
        .where(eq(juniorConversations.conversationId, privateOwned));
      await getDb()
        .insert(juniorConversationBriefs)
        .values({
          content: conversationBriefFixture({
            summary: "Opened the deploy check pull request.",
          }),
          conversationId: publicTarget,
          modelId: "test-model",
          searchText: "deploy check pull request",
          throughSeq: 1,
          turnId: "brief-turn",
          version: 1,
        });
      const searchTopLevel = async (
        conversationId: string,
        input: Record<string, unknown> = {},
        actor: AgentRun["actor"] = parentActor,
      ) => {
        const result = (await createSearchAgentsTool({
          actor,
          conversationId,
        }).execute!({ scope: "top_level", ...input }, {})) as {
          agents: { conversation_id: string; summary?: string }[];
        };
        return result.agents.map((agent) => agent.conversation_id).sort();
      };
      await expect(searchTopLevel(privateSender)).resolves.toEqual(
        [publicTarget, privateOwned, slackParentConversationId].sort(),
      );
      await expect(searchTopLevel(slackParentConversationId)).resolves.toEqual([
        publicTarget,
      ]);
      await expect(
        searchTopLevel(privateSender, {}, EVENT_SYSTEM_ACTOR),
      ).resolves.toEqual([publicTarget, slackParentConversationId].sort());
      await expect(
        searchTopLevel(privateSender, {
          conversation_ids: [privateOwned, privateMember, otherWorkspace],
        }),
      ).resolves.toEqual([privateOwned]);
      await expect(
        searchTopLevel(privateSender, { query: "classifier" }),
      ).resolves.toEqual([privateOwned]);
      // searchConversationEvents reads by the same rule.
      const readEvents = async (
        conversationId: string,
        target: string,
        actor: AgentRun["actor"] = parentActor,
      ) =>
        await createSearchConversationEventsTool({
          actor,
          conversationId,
          destination: { platform: "slack", teamId: "T123", channelId: "C1" },
          egress: { fetch: async () => new Response("ok") },
          source: { kind: "scheduled_automation" },
          workspace: {} as ToolRuntimeContext["workspace"],
        }).execute!({ conversation_id: target }, {});
      await expect(readEvents(privateSender, privateOwned)).resolves.toEqual(
        expect.objectContaining({ events: [] }),
      );
      for (const [requester, target, actor] of [
        [privateSender, privateMember, parentActor],
        [slackParentConversationId, privateOwned, parentActor],
        [privateSender, privateOwned, EVENT_SYSTEM_ACTOR],
        [privateSender, otherWorkspace, parentActor],
      ] as const) {
        await expect(readEvents(requester, target, actor)).rejects.toThrow(
          `Conversation events are not accessible: ${target}`,
        );
      }
      // A linked resource finds the conversations that touched it.
      await annotatePullRequest(publicTarget);
      await expect(
        searchTopLevel(privateSender, { annotation: PULL_REQUEST_KEY }),
      ).resolves.toEqual([publicTarget]);
      await expect(
        createSearchAgentsTool({
          actor: parentActor,
          conversationId: privateSender,
        }).execute!({ scope: "top_level", query: "deploy checks" }, {}),
      ).resolves.toMatchObject({
        agents: [
          {
            conversation_id: publicTarget,
            relation: "top_level",
            summary: "Opened the deploy check pull request.",
          },
        ],
      });
      // An archived conversation is hidden unless asked for.
      await getDb()
        .insert(juniorConversationParticipants)
        .values({
          archivedAt: new Date(2),
          lastMessageAt: new Date(1),
          rootConversationId: privateOwned,
          userId: ana!.id,
        });
      await expect(
        searchTopLevel(privateSender, { conversation_ids: [privateOwned] }),
      ).resolves.toEqual([]);
      await expect(
        createSearchAgentsTool({
          actor: parentActor,
          conversationId: privateSender,
        }).execute!(
          {
            scope: "top_level",
            conversation_ids: [privateOwned],
            include_archived: true,
          },
          {},
        ),
      ).resolves.toEqual({
        agents: [
          expect.objectContaining({
            archived: true,
            conversation_id: privateOwned,
          }),
        ],
      });

      const send = async (
        run: AgentRun,
        to: string,
        toolCallId = "call-top-level",
      ) =>
        await createMessageAgentTool(bindMessageAgent(run, { queue, state })!)
          .execute!(
          { text: "Can you take the deploy check?", to },
          {
            toolCallId,
          },
        );

      // Public to public, in the same Slack workspace. A replay adds no
      // second message.
      const fromPublic = topLevelRun(slackParentConversationId);
      await expect(send(fromPublic, publicTarget)).resolves.toEqual({
        conversation_id: publicTarget,
        delivery: "queued",
      });
      await send(fromPublic, publicTarget);
      const messages = await eventMessages(publicTarget);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        input: {
          metadata: {
            event: {
              eventType: "agent.top_level_message",
              identifier: slackParentConversationId,
              namespace: "junior",
            },
          },
        },
      });
      expect(messages[0]!.input.text).toContain(
        "It is not a message from a person",
      );
      expect(messages[0]!.input.text).toContain(
        `to set to "${slackParentConversationId}"`,
      );

      // A public conversation never reaches a private one, also one that the
      // person owns. Every miss looks the same.
      await expect(send(fromPublic, privateOwned)).rejects.toThrow(
        "a top-level agent that you can message",
      );
      await expect(send(fromPublic, otherWorkspace)).rejects.toThrow(
        "a top-level agent that you can message",
      );
      await expect(send(fromPublic, slackParentConversationId)).rejects.toThrow(
        "is this conversation",
      );

      // A private conversation reaches public agents and private agents that
      // the person owns. Membership is not ownership. The target cannot
      // answer a private sender.
      const fromPrivate = topLevelRun(privateSender);
      await expect(send(fromPrivate, privateOwned)).resolves.toEqual({
        conversation_id: privateOwned,
        delivery: "queued",
      });
      expect((await eventMessages(privateOwned))[0]!.input.text).toContain(
        "cannot message the sender",
      );
      await expect(send(fromPrivate, privateMember)).rejects.toThrow(
        "a top-level agent that you can message",
      );
      await expect(
        send(fromPrivate, publicTarget, "call-private-to-public"),
      ).resolves.toMatchObject({ conversation_id: publicTarget });
      // An event Turn has no person, so it reaches no private agent.
      await expect(
        send(topLevelRun(privateSender, EVENT_SYSTEM_ACTOR), privateOwned),
      ).rejects.toThrow("a top-level agent that you can message");

      // A child agent reaches only its own tree.
      const child = await createAgentInvocation({
        ...slackInvocationInput,
        idempotencyKey: "top-level-child",
      });
      await expect(
        createSearchAgentsTool({
          actor: parentActor,
          conversationId: child.childConversationId,
          parentConversationId: slackParentConversationId,
        }).execute!({ scope: "top_level" }, {}),
      ).rejects.toThrow("A child agent cannot search top_level agents");
      await expect(
        send(childRun(child), publicTarget, "call-from-child"),
      ).rejects.toThrow(`"${publicTarget}" is not "parent" or a child agent`);

      // The target runs the message as an Event, not as the sender's Actor.
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
      await harness.process(queue.takeMessageFor(publicTarget));
      vi.mocked(Date.now).mockRestore();
      expect(runner.runs).toEqual([
        expect.objectContaining({
          actor: EVENT_SYSTEM_ACTOR,
          conversationId: publicTarget,
        }),
      ]);
    } finally {
      await fixture.close();
    }
  });
});
