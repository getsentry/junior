import { createWebSource, type User } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it } from "vitest";
import { canReadConversation } from "@/api/conversations/access";
import { readConversationFeed } from "@/api/conversations/list";
import { bindMessageAgent } from "@/chat/child-agents/message";
import { bindSpawnAgent } from "@/chat/child-agents/spawn";
import type { AgentRun } from "@/chat/agent/types";
import {
  createAndEnqueueConversation,
  webActorFromUser,
} from "@/chat/conversations/web-input";
import { stopConversation } from "@/chat/conversations/stop";
import { ConversationTurnLifecycleService } from "@/chat/conversations/turn-lifecycle";
import {
  getConversationEventStore,
  getConversationStore,
  getDb,
} from "@/chat/db";
import { getSpaceLead } from "@/chat/lead/conversation";
import { readSpaceStates } from "@/api/spaces/state";
import { setConversationSpace } from "@/chat/spaces/conversations";
import { createSpace, readSpace, updateSpace } from "@/chat/spaces/store";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { createMessageAgentTool } from "@/chat/tools/runtime/message-agent";
import { getConversationWorkState } from "@/chat/task-execution/store";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { juniorConversations } from "@/db/schema";
import { inArray } from "drizzle-orm";
import type { StateAdapter } from "chat";
import { createConversationWorkHarness } from "../fixtures/conversation-work";
import { recordSlackRoot } from "../fixtures/conversation-status";
import { signedInViewer } from "../fixtures/user";

/**
 * Integration tests do not run the agent. This runner reads each run and
 * stops it.
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

/** Create a Space with `member` in it, and read its Lead. */
async function spaceLead(
  member: User,
  name = "Deploys",
  visibility: "private" | "public" = "public",
) {
  const space = await createSpace({
    creator: member,
    description: null,
    visibility,
    name,
  });
  return { lead: await getSpaceLead(space.id), space };
}

/** A Turn of `conversationId` that `person` started on the web. */
function personRun(
  conversationId: string,
  person: User,
  turnId: string,
): AgentRun {
  return {
    actor: webActorFromUser(person),
    conversationId,
    destination: { platform: "local", conversationId },
    instruction: { text: "Check the deploy." },
    source: createWebSource(conversationId, "public"),
    turnId,
  };
}

/** `startAgent` in a Turn of `conversationId` that `person` started. */
async function startAgent(
  args: {
    conversationId: string;
    maxAgentDepth?: number;
    person: User;
    queue: ConversationWorkQueue;
    state: StateAdapter;
    turnId?: string;
  },
  toolCallId: string,
  input: { task?: string; title?: string } = {},
) {
  const spawn = bindSpawnAgent(
    personRun(args.conversationId, args.person, args.turnId ?? "lead-turn"),
    {
      ...(args.maxAgentDepth === undefined
        ? undefined
        : { maxAgentDepth: args.maxAgentDepth }),
      queue: args.queue,
      state: args.state,
    },
  )!;
  const { childConversationId } = await spawn(
    { kind: "thread", task: input.task ?? "Check the deploy.", ...input },
    { toolCallId },
  );
  return childConversationId;
}

/** The stored tree columns of some Conversations, by id. */
async function treeRows(conversationIds: string[]) {
  const rows = await getDb()
    .select({
      conversationId: juniorConversations.conversationId,
      parentConversationId: juniorConversations.parentConversationId,
      rootConversationId: juniorConversations.rootConversationId,
      spaceId: juniorConversations.spaceId,
      visibility: juniorConversations.visibility,
      destinationId: juniorConversations.destinationId,
      location: juniorConversations.location,
    })
    .from(juniorConversations)
    .where(inArray(juniorConversations.conversationId, conversationIds));
  return Object.fromEntries(rows.map((row) => [row.conversationId, row]));
}

describe("Lead", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
  });

  it("keeps one public Lead for each Space, named for the Space", async () => {
    const ana = await signedInViewer("lead-ana@example.com");
    const space = await createSpace({
      creator: ana,
      description: null,
      visibility: "public",
      name: "Billing migration",
    });

    // Creating the Space made its Lead.
    const first = await getSpaceLead(space.id);
    expect(first).toMatchObject({
      kind: "lead",
      spaceId: space.id,
      title: "Billing migration",
      visibility: "public",
    });
    expect((await spaceLead(ana, "Other")).lead.conversationId).not.toBe(
      first.conversationId,
    );

    // A Space's name is its Lead's title.
    await updateSpace(space.id, { name: "Billing cutover" });
    expect(
      await getConversationStore().get({
        conversationId: first.conversationId,
      }),
    ).toMatchObject({ title: "Billing cutover" });
    expect((await readSpace(ana.id, space.id))?.name).toBe("Billing cutover");
  });

  it("starts Space work as a child Conversation that runs as the member who asked", async () => {
    const runner = readRunsAgentRunner();
    const harness = await createConversationWorkHarness(runner.agentRunner);
    const ana = await signedInViewer("lead-start@example.com");
    const { lead, space } = await spaceLead(ana);
    const leadTurn = {
      conversationId: lead.conversationId,
      person: ana,
      queue: harness.queue,
      state: harness.state,
    };

    const started = await startAgent(leadTurn, "call-1", {
      task: "Unpublish abc.png from the public image host.",
      title: "Image cleanup",
    });

    expect(
      await getConversationStore().get({ conversationId: started }),
    ).toMatchObject({
      kind: "thread",
      parentConversationId: lead.conversationId,
      spaceId: space.id,
      title: "Image cleanup",
      rootConversationId: lead.conversationId,
      visibility: "public",
    });
    // The Lead is the root of its Space's tree. Only the Lead stores the
    // Space.
    expect((await treeRows([started]))[started]).toMatchObject({
      rootConversationId: lead.conversationId,
      spaceId: null,
    });
    await harness.process(harness.queue.takeMessageFor(started));
    expect(runner.runs[0]!.actor).toMatchObject({
      platform: "web",
      userId: ana.id,
    });

    // A Lead has at most 8 active children, as every parent does.
    for (let index = 0; index < 7; index += 1) {
      await startAgent(leadTurn, `call-more-${index}`);
    }
    await expect(startAgent(leadTurn, "call-ninth")).rejects.toThrow(
      "Parent already has 8 active child agents",
    );
    // A Lead's children are plain children. With the default depth of 2, a
    // Lead's grandchild still starts child agents, and the level below it
    // cannot.
    const grandchild = await startAgent(
      { ...leadTurn, conversationId: started },
      "call-grandchild",
    );
    const greatGrandchild = await startAgent(
      { ...leadTurn, conversationId: grandchild },
      "call-great-grandchild",
    );
    expect((await treeRows([greatGrandchild]))[greatGrandchild]).toMatchObject({
      parentConversationId: grandchild,
      rootConversationId: lead.conversationId,
    });
    await expect(
      startAgent(
        { ...leadTurn, conversationId: greatGrandchild },
        "call-too-deep",
      ),
    ).rejects.toThrow("only 2 level(s) of child agents can start their own");
  });

  it("starts work that a person begins in a Space as a child of the Lead", async () => {
    const harness = await createConversationWorkHarness(
      readRunsAgentRunner().agentRunner,
    );
    const ana = await signedInViewer("lead-direct@example.com");
    const bo = await signedInViewer("lead-direct-bo@example.com");
    const { lead, space } = await spaceLead(ana);

    const { conversationId } = await createAndEnqueueConversation(
      {
        actor: webActorFromUser(bo),
        idempotencyKey: "lead-direct-bo",
        leadConversationId: lead.conversationId,
        message: "Check the deploy.",
      },
      { queue: harness.queue, state: harness.state },
    );

    expect(await getConversationStore().get({ conversationId })).toMatchObject({
      actor: expect.objectContaining({ email: bo.email }),
      parentConversationId: lead.conversationId,
      spaceId: space.id,
      rootConversationId: lead.conversationId,
    });
    // The Space's top-level list shows its children.
    const feed = await readConversationFeed({ spaceId: space.id, viewer: ana });
    expect(
      feed.conversations.map((conversation) => conversation.conversationId),
    ).toEqual([conversationId]);

    // A member's own feed lists roots, so it leaves out the Lead's
    // children.
    expect(
      (await readConversationFeed({ viewer: ana })).conversations.map(
        (conversation) => conversation.conversationId,
      ),
    ).not.toContain(conversationId);
  });

  it("moves a Conversation and its child agents into, between, and out of Spaces", async () => {
    const harness = await createConversationWorkHarness(
      readRunsAgentRunner().agentRunner,
    );
    const ana = await signedInViewer("lead-move@example.com");
    const first = await spaceLead(ana, "Deploys");
    const second = await spaceLead(ana, "Billing");
    const { conversationId } = await createAndEnqueueConversation(
      {
        actor: webActorFromUser(ana),
        idempotencyKey: "lead-move",
        message: "Check the deploy.",
      },
      { queue: harness.queue, state: harness.state },
    );
    const child = await startAgent(
      {
        conversationId,
        person: ana,
        queue: harness.queue,
        state: harness.state,
      },
      "call-move-child",
    );
    const target = (space: typeof first) => ({
      leadConversationId: space.lead.conversationId,
      spaceId: space.space.id,
    });

    await expect(
      setConversationSpace(conversationId, target(first), null),
    ).resolves.toBeUndefined();
    // Its work takes the Lead's Destination, as every child stores its
    // parent's.
    const firstLeadDestination = (await treeRows([first.lead.conversationId]))[
      first.lead.conversationId
    ]!.destinationId;
    expect(await treeRows([conversationId, child])).toMatchObject({
      [conversationId]: {
        destinationId: firstLeadDestination,
        parentConversationId: first.lead.conversationId,
        rootConversationId: first.lead.conversationId,
      },
      [child]: {
        destinationId: firstLeadDestination,
        parentConversationId: conversationId,
        rootConversationId: first.lead.conversationId,
      },
    });
    expect(
      await getConversationStore().get({ conversationId: child }),
    ).toMatchObject({ spaceId: first.space.id });

    // A move checks the Space that the caller read.
    await expect(
      setConversationSpace(conversationId, target(second), null),
    ).resolves.toBe("moved");
    await setConversationSpace(conversationId, target(second), first.space.id);
    expect(await treeRows([conversationId, child])).toMatchObject({
      [conversationId]: {
        parentConversationId: second.lead.conversationId,
        rootConversationId: second.lead.conversationId,
      },
      [child]: { rootConversationId: second.lead.conversationId },
    });

    // Out of the Space, the work is a plain root again, with a Destination
    // of its own.
    await setConversationSpace(conversationId, null, second.space.id);
    const left = await treeRows([conversationId, child]);
    expect(left).toMatchObject({
      [conversationId]: {
        parentConversationId: null,
        rootConversationId: conversationId,
      },
      [child]: {
        destinationId: left[conversationId]!.destinationId,
        parentConversationId: conversationId,
        rootConversationId: conversationId,
      },
    });
    expect(left[conversationId]!.destinationId).not.toBe(
      (await treeRows([second.lead.conversationId]))[
        second.lead.conversationId
      ]!.destinationId,
    );
    expect(
      await getConversationStore().get({ conversationId }),
    ).not.toHaveProperty("spaceId");

    // A move never makes private work public.
    const { conversationId: secret } = await createAndEnqueueConversation(
      {
        actor: webActorFromUser(ana),
        idempotencyKey: "lead-move-private",
        message: "Check my notes.",
        visibility: "private",
      },
      { queue: harness.queue, state: harness.state },
    );
    await expect(
      setConversationSpace(secret, target(first), null),
    ).resolves.toBe("private");
    expect((await treeRows([secret]))[secret]).toMatchObject({
      parentConversationId: null,
      rootConversationId: secret,
    });
  });

  it("drops a Slack Conversation's own Location when it moves into a Space", async () => {
    const ana = await signedInViewer("lead-slack@example.com");
    const { lead, space } = await spaceLead(ana);
    const slack = await recordSlackRoot(
      getConversationStore(),
      "1700000000.000710",
    );
    const slackDestination = (await getConversationStore().get({
      conversationId: slack,
    }))!.destination!;

    await setConversationSpace(
      slack,
      { leadConversationId: lead.conversationId, spaceId: space.id },
      null,
    );

    // It uses its Lead's Destination and Location, as every child does, so
    // the Slack thread gets no replies.
    const rows = await treeRows([slack, lead.conversationId]);
    expect(rows[slack]).toMatchObject({
      destinationId: rows[lead.conversationId]!.destinationId,
      location: null,
      parentConversationId: lead.conversationId,
    });
    // Later Slack input in the thread, and a Run that read the Slack
    // Destination before the move, keep the Lead's.
    await getConversationStore().recordActivity({
      conversationId: slack,
      destination: slackDestination,
      nowMs: Date.now(),
      source: "slack",
    });
    const moved = await getConversationStore().get({ conversationId: slack });
    await getConversationStore().recordExecution({
      conversationId: slack,
      createdAtMs: moved!.createdAtMs,
      destination: slackDestination,
      execution: { status: "idle", updatedAtMs: Date.now() },
      lastActivityAtMs: Date.now(),
      metrics: null,
      updatedAtMs: Date.now(),
    });
    expect((await treeRows([slack]))[slack]).toMatchObject({
      destinationId: rows[lead.conversationId]!.destinationId,
      location: null,
    });

    // Out of the Space it is a plain root with its own local Destination,
    // and later Slack input keeps that one.
    await expect(setConversationSpace(slack, null, space.id)).resolves.toBe(
      undefined,
    );
    const own = (await treeRows([slack]))[slack]!.destinationId;
    expect(own).not.toBe(rows[lead.conversationId]!.destinationId);
    await getConversationStore().recordActivity({
      conversationId: slack,
      destination: slackDestination,
      nowMs: Date.now(),
      source: "slack",
    });
    expect((await treeRows([slack]))[slack]).toMatchObject({
      destinationId: own,
      location: null,
      parentConversationId: null,
    });
  });

  it("starts a Lead Turn for each result of its child, as for any parent", async () => {
    const harness = await createConversationWorkHarness(
      readRunsAgentRunner().agentRunner,
    );
    const ana = await signedInViewer("lead-done@example.com");
    const { lead } = await spaceLead(ana);
    const child = await startAgent(
      {
        conversationId: lead.conversationId,
        person: ana,
        queue: harness.queue,
        state: harness.state,
      },
      "call-done-child",
      { title: "Deploy check" },
    );
    const lifecycle = new ConversationTurnLifecycleService(
      getConversationEventStore(),
      { watchQueue: () => harness.queue },
    );
    const leadMailbox = async () =>
      (
        await getConversationWorkState({
          conversationId: lead.conversationId,
          state: harness.state,
        })
      )?.messages.map((message) => message.input.text) ?? [];

    await lifecycle.start({
      conversationId: child,
      createdAtMs: Date.now(),
      inputMessageIds: ["person-message-1"],
      surface: "internal",
      turnId: "child-turn-1",
    });
    await lifecycle.complete({
      conversationId: child,
      createdAtMs: Date.now(),
      outcome: "success",
      turnId: "child-turn-1",
    });
    // A done result reminds the Lead that a status update needs no reply.
    expect(await leadMailbox()).toEqual([
      expect.stringMatching(/status="done"[\s\S]*end with `noReply`\./),
    ]);

    await lifecycle.fail({
      conversationId: child,
      createdAtMs: Date.now(),
      failureCode: "agent_run_failed",
      turnId: "child-turn-2",
    });
    expect(await leadMailbox()).toEqual([
      expect.stringMatching(/status="done"/),
      expect.stringMatching(/status="failed"[\s\S]*<\/agent-result>$/),
    ]);
  });

  it("keeps a private Space's work with its members", async () => {
    const harness = await createConversationWorkHarness(
      readRunsAgentRunner().agentRunner,
    );
    const ana = await signedInViewer("lead-private@example.com");
    const bo = await signedInViewer("lead-private-bo@example.com");
    const { lead, space } = await spaceLead(ana, "Payroll audit", "private");
    expect(lead.visibility).toBe("private");
    const started = await startAgent(
      {
        conversationId: lead.conversationId,
        person: ana,
        queue: harness.queue,
        state: harness.state,
      },
      "call-private",
    );
    expect(
      await getConversationStore().get({ conversationId: started }),
    ).toMatchObject({ spaceId: space.id, visibility: "private" });

    const { conversationId: outside } = await createAndEnqueueConversation(
      {
        actor: webActorFromUser(bo),
        idempotencyKey: "lead-private-outside",
        message: "Check the deploy.",
      },
      { queue: harness.queue, state: harness.state },
    );
    // The Lead reads its children. Work outside the Space does not, also
    // when it is public.
    await expect(
      canReadConversation(getDb(), lead.conversationId, started),
    ).resolves.toBe(true);
    await expect(canReadConversation(getDb(), outside, started)).resolves.toBe(
      false,
    );
    // Only a member finds the Space's work in its list.
    const listed = async (viewer: User) =>
      (
        await readConversationFeed({ spaceId: space.id, viewer })
      ).conversations.map((conversation) => conversation.conversationId);
    expect(await listed(ana)).toEqual([started]);
    expect(await listed(bo)).toEqual([]);
  });

  it("steers its children and other public roots, as any root", async () => {
    const runner = readRunsAgentRunner();
    const { queue, state } = await createConversationWorkHarness(
      runner.agentRunner,
    );
    const ana = await signedInViewer("lead-steer@example.com");
    const bo = await signedInViewer("lead-other@example.com");
    const { lead } = await spaceLead(ana);
    const start = async (person: User, key: string, leadId?: string) =>
      (
        await createAndEnqueueConversation(
          {
            actor: webActorFromUser(person),
            idempotencyKey: key,
            message: "Check the deploy.",
            ...(leadId ? { leadConversationId: leadId } : undefined),
          },
          { queue, state },
        )
      ).conversationId;
    const boInSpace = await start(
      bo,
      "lead-steer-bo-space",
      lead.conversationId,
    );
    const anaOutside = await start(ana, "lead-steer-ana");
    const boOutside = await start(bo, "lead-steer-bo");

    const send = async (to: string, toolCallId: string) =>
      await createMessageAgentTool(
        bindMessageAgent(
          personRun(lead.conversationId, ana, "lead-steer-turn"),
          { queue, state },
        )!,
      ).execute!({ text: "Please hurry.", to }, { toolCallId });

    // Any child of the Lead, whoever started it.
    await expect(send(boInSpace, "call-space")).resolves.toMatchObject({
      conversation_id: boInSpace,
    });
    // Outside the Space, any public root, as from any public root.
    await expect(send(anaOutside, "call-ana")).resolves.toMatchObject({
      conversation_id: anaOutside,
    });
    await expect(send(boOutside, "call-bo")).resolves.toMatchObject({
      conversation_id: boOutside,
    });
  });

  it("rolls up its children, and stops them with the Lead", async () => {
    const harness = await createConversationWorkHarness(
      readRunsAgentRunner().agentRunner,
    );
    const ana = await signedInViewer("lead-stop@example.com");
    const { lead, space } = await spaceLead(ana);
    const leadTurn = {
      conversationId: lead.conversationId,
      person: ana,
      queue: harness.queue,
      state: harness.state,
    };
    const first = await startAgent(leadTurn, "call-stop-1");
    const second = await startAgent(leadTurn, "call-stop-2");
    const grandchild = await startAgent(
      { ...leadTurn, conversationId: first },
      "call-stop-grandchild",
    );

    // The sidebar rolls up the Lead's direct children.
    const states = await readSpaceStates(getDb(), [space.id], ana.id);
    expect(states.get(space.id)).toEqual({
      latestTurnFailed: false,
      treeState: "working",
    });

    // A stop of the Lead stops the whole Space tree.
    await stopConversation({
      conversationId: lead.conversationId,
      queue: harness.queue,
      state: harness.state,
    });
    for (const conversationId of [first, second, grandchild]) {
      expect(
        await getConversationStore().get({ conversationId }),
      ).toMatchObject({ stoppedAtMs: expect.any(Number) });
    }
  });
});
