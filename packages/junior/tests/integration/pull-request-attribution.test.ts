import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { githubPlugin } from "@sentry/junior-github";
import {
  createEventSource,
  createSlackSource,
} from "@sentry/junior-plugin-api";
import { createApp, defineJuniorPlugins } from "@/app";
import { getDispatchConversationId } from "@/chat/agent-dispatch/store";
import { bindMessageAgent } from "@/chat/agent-invocations/message";
import { bindSpawnAgent } from "@/chat/agent-invocations/spawn";
import type { AgentRun } from "@/chat/agent/types";
import { turnBehavior } from "@/chat/conversations/kind-behavior";
import { credentialContextForActor } from "@/chat/credentials/context";
import { getConversationStore, getSqlExecutor } from "@/chat/db";
import { EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
import { upsertIdentity } from "@/chat/identities/sql";
import { getPluginTools } from "@/chat/plugins/agent-hooks";
import { migratePluginSchemas } from "@/chat/plugins/migrations";
import { readActorIdentity } from "@/chat/plugins/viewer";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { createAgentDispatchTestRecord } from "../fixtures/agent-dispatch";
import { createConversationWorkHarness } from "../fixtures/conversation-work";
import {
  destination,
  prepareSlackParentConversation,
  slackDestination,
  slackInvocationInput,
  slackParentConversationId,
} from "../fixtures/agent-invocations";

const person = slackInvocationInput.actor;
const checksFailedSource = createEventSource({
  eventKey: "check_run:1",
  eventType: "pull_request.checks.failed",
  identifier: "getsentry/junior#1591",
  namespace: "github",
});

/** A Turn that a system Actor runs on one Conversation, such as a Watch Event. */
function systemRun(conversationId: string, turnId: string): AgentRun {
  return {
    actor: EVENT_SYSTEM_ACTOR,
    conversationId,
    credentialContext: credentialContextForActor(EVENT_SYSTEM_ACTOR),
    destination:
      conversationId === slackParentConversationId
        ? slackDestination
        : destination,
    instruction: { text: "Checks failed." },
    source: checksFailedSource,
    turnId,
  };
}

/**
 * Start the GitHub plugin and a Slack root that a person started.
 * Integration tests do not run the agent, so the runner reads each Run and
 * stops it.
 */
async function prepare() {
  await createApp({ plugins: defineJuniorPlugins([githubPlugin()]) });
  await upsertIdentity(getSqlExecutor(), {
    displayName: "Pat Requester",
    kind: "user",
    provider: "slack",
    providerSubjectId: person.userId,
    providerTenantId: person.teamId,
  });
  const { fixture } = await prepareSlackParentConversation();
  await migratePluginSchemas(fixture.sql, [
    {
      dir: path.resolve(process.cwd(), "../junior-github/migrations"),
      pluginName: "github",
    },
  ]);
  await getConversationStore().recordActivity({
    actor: {
      platform: "slack",
      slackUserId: person.userId,
      teamId: person.teamId,
    },
    conversationId: slackParentConversationId,
    destination: slackDestination,
    nowMs: 2_000,
    source: "slack",
  });
  const runs: AgentRun[] = [];
  const harness = await createConversationWorkHarness({
    run: async (run: AgentRun): Promise<never> => {
      runs.push(run);
      throw new Error("stop after reading the run");
    },
  });
  const { queue, state } = harness;
  const runOf = async (conversationId: string) => {
    await harness.process(queue.takeMessageFor(conversationId));
    return runs.at(-1)!;
  };
  const spawn = async (run: AgentRun, toolCallId: string, name?: string) =>
    await runOf(
      (
        await bindSpawnAgent(run, { maxAgentDepth: 3, queue, state })!(
          { ...(name ? { name } : undefined), task: "Open a pull request." },
          { toolCallId },
        )
      ).childConversationId,
    );
  const message = async (run: AgentRun, to: string, toolCallId: string) => {
    const { conversationId } = await bindMessageAgent(run, { queue, state })!(
      { text: "Fix the failing check.", to },
      { toolCallId },
    );
    return await runOf(conversationId);
  };

  const opened: Array<{ body: string }> = [];
  /** Open a pull request from one Run through the GitHub plugin. */
  const createPullRequest = async (run: AgentRun) =>
    await getPluginTools({
      actor: run.actor,
      conversationId: run.conversationId,
      destination: run.destination,
      egress: {
        fetch: async ({ request }) => {
          if (request.method === "POST" && request.url.endsWith("/pulls")) {
            opened.push(await request.json());
          }
          return Response.json(
            {
              html_url: "https://github.com/getsentry/junior/pull/1592",
              number: 1592,
            },
            { status: 201 },
          );
        },
      },
      resolveActorIdentity: async () => await readActorIdentity(run.actor!),
      source: { kind: "agent_invocation" },
      turnTools: turnBehavior({ kind: "task", personInput: false }).tools,
      workspace: {} as any,
    })["github_createPullRequest"]!.execute!(
      {
        base: "main",
        body: "Fix the check.",
        head: "fix/check",
        repo: "getsentry/junior",
        title: "fix: Check",
      },
      { toolCallId: `create-${run.conversationId}-${run.turnId}` },
    );
  return { createPullRequest, fixture, message, opened, spawn };
}

describe("pull request attribution", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
  });

  // Credentials stay with the Turn Actor. A pull request from a system Turn
  // names the person who started the root Conversation.
  it("names the root Actor when a system Turn gives a child agent work", async () => {
    const { createPullRequest, fixture, message, opened, spawn } =
      await prepare();
    try {
      const personRun: AgentRun = {
        actor: person,
        conversationId: slackParentConversationId,
        credentialContext: credentialContextForActor(person),
        destination: slackDestination,
        instruction: { text: "Fix the check." },
        source: createSlackSource({
          channelId: "C123",
          teamId: "T123",
          threadTs: "1712345.0001",
          visibility: "public",
        }),
        turnId: "person-turn",
      };
      await spawn(personRun, "call-spawn-person", "builder");
      const systemParent = systemRun(slackParentConversationId, "system-turn");
      const messaged = await message(systemParent, "builder", "call-fix");
      const spawned = await spawn(systemParent, "call-spawn-system");
      // A child that a system Turn starts runs as that Turn's Actor.
      expect(spawned.actor).toEqual(EVENT_SYSTEM_ACTOR);

      await createPullRequest(messaged);
      await createPullRequest(spawned);
      expect(opened.map(({ body }) => body)).toEqual(
        Array(2).fill(expect.stringContaining("via **Pat Requester**.")),
      );
    } finally {
      await fixture.close();
    }
  });

  // Every Turn of an Automation run, and every child agent below it at any
  // depth, does the run's work, so its pull requests name the run.
  it("names the Automation run of the root", async () => {
    const { createPullRequest, fixture, opened, spawn } = await prepare();
    try {
      const dispatch = await createAgentDispatchTestRecord(
        "automation-children",
        undefined,
        {
          kind: "scheduled_automation",
          automationId: "sched_1",
          automationRunId: "run_1",
        },
      );
      const conversationId = getDispatchConversationId(dispatch);
      await getConversationStore().recordActivity({
        conversationId,
        destination,
        nowMs: 1_000,
        source: "scheduler",
      });
      const watchTurn = systemRun(conversationId, "automation-watch-turn");
      const child = await spawn(watchTurn, "call-spawn", "builder");
      const grandchild = await spawn(child, "call-spawn-nested");

      await createPullRequest(watchTurn);
      await createPullRequest(grandchild);
      expect(opened.map(({ body }) => body)).toEqual(
        Array(2).fill(
          expect.stringMatching(/automation `sched_1`.* · Run ID `run_1`\./),
        ),
      );
    } finally {
      await fixture.close();
    }
  });

  // A root that the system started with no Automation run, such as a plugin
  // dispatch, has nobody to name.
  it("rejects a pull request when nobody asked for the work", async () => {
    const { createPullRequest, fixture, opened, spawn } = await prepare();
    try {
      const dispatch = await createAgentDispatchTestRecord(
        "plugin-dispatch",
        undefined,
        { kind: "plugin_dispatch" },
      );
      const conversationId = getDispatchConversationId(dispatch);
      await getConversationStore().recordActivity({
        conversationId,
        destination,
        nowMs: 1_000,
        source: "scheduler",
      });
      const child = await spawn(
        systemRun(conversationId, "dispatch-turn"),
        "call-spawn-dispatch",
      );

      await expect(createPullRequest(child)).rejects.toThrow(
        "Cannot open a pull request: no person or Automation run asked for this work.",
      );
      expect(opened).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});
