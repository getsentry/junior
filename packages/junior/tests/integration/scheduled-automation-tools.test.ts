import { createAutomationTool } from "@/chat/automations/tools/create";
import type { EventCatalog } from "@/chat/events/catalog";
import { createUpdateAutomationTool } from "@/chat/automations/tools/update";
import { createDeleteAutomationTool } from "@/chat/automations/tools/delete";
import { createSearchAutomationsTool } from "@/chat/automations/tools/search";
import { createRunAutomationNowTool } from "@/chat/automations/tools/run-now";
import { getConversationStore } from "@/chat/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  automationToolContext,
  type AutomationToolContext,
} from "@/chat/automations/tool-access";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import {
  claimDueScheduledRun,
  markScheduledRunFailed,
} from "@/chat/scheduled-automations/runs";
import {
  listScheduledAutomations as listStoredTasks,
  listScheduledAutomationsForTeam as listStoredTasksForTeam,
  readScheduledAutomation as readStoredTask,
  saveScheduledAutomation,
} from "@/chat/scheduled-automations/tasks";
import type { ScheduledAutomation } from "@/chat/scheduled-automations/types";
import * as dbModule from "@/chat/db";
import { getPluginTools, setPlugins } from "@/chat/plugins/agent-hooks";
import { createTools } from "@/chat/tools";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import type { ToolExecuteOptions } from "@/chat/tools/definition";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { JuniorDatabase } from "@/db/db";
import { juniorIdentities, juniorUsers } from "@/db/schema";
import { readUserTimezone } from "@/chat/identities/sql";
import {
  createJuniorSqlFixture,
  type LocalJuniorSqlFixture,
} from "../fixtures/sql";
import {
  createSlackSource,
  createWebSource,
  type SlackActor,
  type SlackSource,
} from "@sentry/junior-plugin-api";
import {
  getCapturedSlackApiCalls,
  queueSlackApiResponse,
} from "../msw/handlers/slack-api";
import { usersInfoOk } from "../fixtures/slack/factories/api";
vi.hoisted(() => {
  process.env.JUNIOR_STATE_ADAPTER = "memory";
});

const TEST_TEAM_ID = `TSCHEDULE${Date.now()}`;
// These tests create only scheduled automations.
const NO_EVENTS: EventCatalog = {};
let currentFixture: LocalJuniorSqlFixture | undefined;
let toolCallSequence = 0;

async function useSchedulerSqlPlugin() {
  const fixture = await createJuniorSqlFixture();
  vi.spyOn(dbModule, "getDb").mockReturnValue(fixture.sql.db());
  for (const conversationId of [
    "test:schedule-cards",
    "slack:DDM:1700000000.100000",
  ]) {
    await getConversationStore().recordActivity({
      conversationId,
      destination: { platform: "local", conversationId },
      source: "local",
      nowMs: Date.now(),
    });
  }
  return fixture;
}

/** Store the Slack identity that Slack turns store before tools run. */
async function storeSlackIdentity(teamId: string, userId: string) {
  const identity = {
    id: `identity:${teamId}:${userId}`,
    provider: "slack",
    providerSubjectId: userId,
    providerTenantId: teamId,
  };
  const now = new Date();
  await dbModule
    .getDb()
    .insert(juniorIdentities)
    .values({ ...identity, kind: "user", createdAt: now, updatedAt: now })
    .onConflictDoNothing();
  return identity;
}

/**
 * Build the tool context that runtime wiring builds for one Slack message
 * Turn. `source` replaces the Slack message Source.
 */
function createContext(
  overrides: Partial<Omit<AutomationToolContext, "actor">> & {
    actor?: SlackActor;
    channelId?: string;
    linkedUser?: boolean;
    source?: SlackSource;
    teamId?: string;
  } = {},
): AutomationToolContext {
  const {
    actor: actorOverride,
    channelId = "C123",
    linkedUser,
    source: sourceOverride,
    teamId = TEST_TEAM_ID,
    ...contextOverrides
  } = overrides;
  const actor = actorOverride ?? {
    platform: "slack" as const,
    teamId,
    userId: "U123",
    userName: "dcramer",
    fullName: "David Cramer",
  };
  const identity = {
    id: `identity:${actor.teamId}:${actor.userId}`,
    provider: "slack",
    providerSubjectId: actor.userId,
    providerTenantId: actor.teamId,
  };
  const user =
    linkedUser === false
      ? undefined
      : {
          email: `${actor.userId.toLowerCase()}@example.com`,
          id: `user:${actor.userId}`,
          identities: [identity],
        };
  const source =
    sourceOverride ??
    createSlackSource({
      teamId,
      channelId,
      visibility: channelId.startsWith("C") ? "public" : "private",
    });
  const runtime = {
    conversationId: "test:schedule-cards",
    source,
    destination: { platform: "slack", teamId, channelId },
    actor,
    userText: "schedule this weekly",
  } as ToolRuntimeContext;
  return {
    ...automationToolContext(runtime),
    now: () => Date.parse("2026-05-24T12:00:00.000Z"),
    users: {
      resolveActor: async () => ({
        identity: await storeSlackIdentity(actor.teamId, actor.userId),
        ...(user ? { user } : undefined),
      }),
    },
    ...contextOverrides,
  };
}

async function executeTool<TOutput>(
  tool: {
    execute?: (
      input: unknown,
      options: ToolExecuteOptions,
    ) => Promise<TOutput> | TOutput;
    prepareArguments?: (input: unknown) => unknown;
  },
  input: unknown,
  options: ToolExecuteOptions = {},
): Promise<TOutput> {
  if (typeof tool?.execute !== "function") {
    throw new Error("tool execute function missing");
  }
  const prepared = tool.prepareArguments?.(input) ?? input;
  return await tool.execute(prepared, {
    toolCallId: `test-scheduler-call-${toolCallSequence++}`,
    ...options,
  });
}

async function executeRegisteredTool<TDetails>(
  tool: {
    execute?: (input: unknown, options: {}) => Promise<unknown> | unknown;
    prepareArguments?: (input: unknown) => unknown;
  },
  input: unknown,
): Promise<TDetails> {
  if (typeof tool?.execute !== "function") {
    throw new Error("tool execute function missing");
  }
  return (await tool.execute(tool.prepareArguments?.(input) ?? input, {
    toolCallId: `test-scheduler-call-${toolCallSequence++}`,
  })) as TDetails;
}

function schedulerDb(): JuniorDatabase {
  if (!currentFixture) {
    throw new Error("Scheduler SQL database is not initialized");
  }
  return currentFixture.sql.db();
}

function queueSlackTimezone(userId: string, tz: string) {
  queueSlackApiResponse("users.info", { body: usersInfoOk({ userId, tz }) });
}

async function insertUser(userId: string, timezone?: string) {
  const now = new Date("2026-05-24T12:00:00.000Z");
  await schedulerDb()
    .insert(juniorUsers)
    .values({
      id: `user:${userId}`,
      primaryEmail: `${userId.toLowerCase()}@example.com`,
      primaryEmailNormalized: `${userId.toLowerCase()}@example.com`,
      timezone: timezone ?? null,
      createdAt: now,
      updatedAt: now,
    });
}

function slackActor(userId: string) {
  return { platform: "slack" as const, teamId: TEST_TEAM_ID, userId };
}

async function readScheduledAutomation(id: string) {
  return await readStoredTask(schedulerDb(), id);
}

async function listScheduledAutomationsForTeam(teamId: string) {
  return await listStoredTasksForTeam(schedulerDb(), teamId);
}

async function listScheduledAutomations() {
  return await listStoredTasks(schedulerDb());
}

async function initializeSchedulerSqlStore(): Promise<void> {
  currentFixture = await useSchedulerSqlPlugin();
}

async function cleanupSchedulerSqlStore(): Promise<void> {
  await currentFixture?.close();
  currentFixture = undefined;
}

async function createTask(
  context = createContext(),
  overrides: Record<string, unknown> = {},
) {
  const tool = createAutomationTool(context, NO_EVENTS);
  return await executeTool(tool, {
    instruction:
      "Weekly issue digest: Summarize open scheduler issues and post a concise summary.",
    trigger: {
      type: "schedule",
      schedule: {
        kind: "recurring",
        frequency: "weekly",
        time: "09:00",
        weekdays: ["monday"],
        timezone: "America/Los_Angeles",
      },
    },
    ...overrides,
  });
}

describe("Scheduled automation tools", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
    await initializeSchedulerSqlStore();
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env.JUNIOR_TIMEZONE;
    await cleanupSchedulerSqlStore();
    vi.restoreAllMocks();
    await disconnectStateAdapter();
  });

  it("exposes a required structured schedule without model-computed timestamps", async () => {
    const createTool = createAutomationTool(createContext(), NO_EVENTS);
    const updateTool = createUpdateAutomationTool(createContext(), NO_EVENTS);
    const deleteTool = createDeleteAutomationTool(createContext(), NO_EVENTS);
    const runNowTool = createRunAutomationNowTool(createContext(), NO_EVENTS);
    const listTool = createSearchAutomationsTool(createContext(), NO_EVENTS);
    const schema = createTool.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };

    expect(createTool.approvalMode).toBe("review");
    expect(updateTool.approvalMode).toBe("review");
    expect(deleteTool.approvalMode).toBe("review");
    expect(runNowTool.approvalMode).toBe("review");
    // Read-only listing stays outside Guardian; mutating schedule tools do not.
    expect(listTool.approvalMode).toBeUndefined();
    expect(schema.required).toContain("trigger");
    expect(schema.properties).not.toHaveProperty("nextRunAt");
    expect(schema.properties).not.toHaveProperty("schedule_kind");
    expect(schema.properties).not.toHaveProperty("destination");
    expect(
      (updateTool.inputSchema as { properties?: Record<string, unknown> })
        .properties,
    ).toHaveProperty("credentialMode");
  });

  it("accepts a structured relative one-off schedule", async () => {
    const tool = createAutomationTool(createContext(), NO_EVENTS);

    expect(
      tool.prepareArguments?.({
        instruction: "Remind Greg to drink water.",
        trigger: {
          type: "schedule",
          schedule: {
            kind: "one_off",
            timezone: null,
            timing: { type: "after", value: 1, unit: "minute" },
          },
        },
      }),
    ).toMatchObject({
      trigger: {
        type: "schedule",
        schedule: {
          kind: "one_off",
          timezone: null,
          timing: { type: "after" },
        },
      },
    });
  });

  it("creates a channel task from a thread", async () => {
    const context = createContext({
      source: createSlackSource({
        teamId: TEST_TEAM_ID,
        channelId: "C123",
        threadTs: "1700000000.000100",
        visibility: "public",
      }),
    });
    const created = await createTask(context, {
      title: "Weekly issue digest",
      outcomes: [
        {
          action: "send_message",
          destination: "current_conversation",
        },
      ],
    });

    expect(created).toMatchObject({
      automation: {
        destination: { channel: "C123", thread: null },
        outcomes: [
          {
            destination: { channel: "C123", thread: null },
          },
        ],
      },
    });
    await expect(
      readScheduledAutomation(created.automation.id),
    ).resolves.toMatchObject({
      destination: { channelId: "C123" },
      outcomes: [{ destination: { channelId: "C123" } }],
    });
    await expect(
      readScheduledAutomation(created.automation.id),
    ).resolves.not.toHaveProperty("destination.threadTs");
  });

  it("stores a direct message outcome created from a channel", async () => {
    const created = await createTask(createContext(), {
      outcomes: [
        {
          action: "send_message",
          destination: "task_creator",
        },
      ],
    });

    expect(getCapturedSlackApiCalls("conversations.open")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({ users: "U123" }),
      }),
    ]);
    await expect(
      readScheduledAutomation(created.automation.id),
    ).resolves.toMatchObject({
      destination: { channelId: "C123" },
      outcomes: [
        {
          action: "send_message",
          destination: {
            channelId: "D0TEST",
            platform: "slack",
            teamId: TEST_TEAM_ID,
          },
        },
      ],
    });
  });

  it("creates and lists tasks only for the active Slack conversation", async () => {
    const created = await createTask(createContext(), {
      title: "Weekly issue digest",
    });
    expect(created).toMatchObject({
      objectCards: [
        {
          kind: "object",
          objectType: "automation",
          plugin: "junior",
          key: created.automation.id,
          label: "Weekly issue digest",
          trigger: "Every week on Monday at 09:00 (America/Los_Angeles)",
        },
      ],
    });
    expect(created).toMatchObject({
      automation: {
        conversationAccess: {
          audience: "channel",
          visibility: "public",
        },
        credentialMode: "creator",
        outcomes: [],
        status: "active",
        instruction:
          "Weekly issue digest: Summarize open scheduler issues and post a concise summary.",
        recurrence: {
          frequency: "weekly",
          interval: 1,
          weekdays: [1],
        },
        nextRunAt: "2026-05-25T16:00:00.000Z",
      },
    });
    await expect(
      readScheduledAutomation(created.automation.id),
    ).resolves.toMatchObject({
      creatorIdentityId: `identity:${TEST_TEAM_ID}:U123`,
    });
    expect(created).not.toHaveProperty("data");

    const listed = await executeTool(
      createSearchAutomationsTool(createContext(), NO_EVENTS),
      {},
    );
    expect(listed).toMatchObject({
      automations: [
        {
          instruction:
            "Weekly issue digest: Summarize open scheduler issues and post a concise summary.",
          schedule: "Every week on Monday at 09:00 (America/Los_Angeles)",
        },
      ],
    });
    expect(listed).not.toHaveProperty("data");
    expect(listed).not.toHaveProperty("cards");

    const sameChannelOtherThread = await executeTool(
      createSearchAutomationsTool(createContext(), NO_EVENTS),
      {},
    );
    expect(sameChannelOtherThread).toMatchObject({
      automations: [
        {
          instruction:
            "Weekly issue digest: Summarize open scheduler issues and post a concise summary.",
          schedule: "Every week on Monday at 09:00 (America/Los_Angeles)",
        },
      ],
    });
  });

  it("stores identity ownership before the creator is linked to a user", async () => {
    const context = createContext({ linkedUser: false });
    const created = await createTask(context);

    const stored = await readScheduledAutomation(created.automation.id);
    expect(stored).toMatchObject({
      creatorIdentityId: `identity:${TEST_TEAM_ID}:U123`,
    });

    // The Slack creator stays the creator when the identity lookup is empty.
    const noIdentity = createContext({
      channelId: "C999",
      users: { resolveActor: async () => undefined },
    });
    await expect(
      executeTool(createUpdateAutomationTool(noIdentity, NO_EVENTS), {
        automationId: created.automation.id,
        instruction: "Creator edit without an identity lookup.",
        outcomes: [],
      }),
    ).resolves.toMatchObject({
      automation: { credentialMode: "creator", isCreator: true },
    });
  });

  it("creates clear recurring tasks without a second confirmation", async () => {
    const result = await executeTool(
      createAutomationTool(createContext(), NO_EVENTS),
      {
        instruction:
          "Weekly issue digest: Summarize open scheduler issues and post a concise summary.",
        trigger: {
          type: "schedule",
          schedule: {
            kind: "recurring",
            frequency: "weekly",
            time: "09:00",
            weekdays: ["monday"],
            timezone: "America/Los_Angeles",
          },
        },
      },
    );

    expect(result).toMatchObject({
      automation: {
        schedule: "Every week on Monday at 09:00 (America/Los_Angeles)",
        status: "active",
        instruction:
          "Weekly issue digest: Summarize open scheduler issues and post a concise summary.",
      },
    });
    await expect(
      listScheduledAutomationsForTeam(TEST_TEAM_ID),
    ).resolves.toMatchObject([
      {
        destination: { channelId: "C123" },
        status: "active",
      },
    ]);
  });

  it("returns the existing task when a create tool call is replayed", async () => {
    let nowCalls = 0;
    const context = createContext({
      now: () => Date.parse("2026-05-24T12:00:00.000Z") + nowCalls++ * 1_000,
    });
    const tool = createAutomationTool(context, NO_EVENTS);
    const input = {
      instruction: "Post the scheduler reminder.",
      trigger: {
        type: "schedule" as const,
        schedule: {
          kind: "one_off" as const,
          timing: {
            type: "after" as const,
            value: 1,
            unit: "minute" as const,
          },
        },
      },
    };

    const [first, replay] = await Promise.all([
      executeTool(tool, input, { toolCallId: "call-create-1" }),
      executeTool(tool, input, { toolCallId: "call-create-1" }),
    ]);

    expect(replay.automation.id).toBe(first.automation.id);
    expect(replay.automation).toEqual(first.automation);
    await expect(
      listScheduledAutomationsForTeam(TEST_TEAM_ID),
    ).resolves.toHaveLength(1);
  });

  it("allows separate create calls to make equivalent tasks", async () => {
    const tool = createAutomationTool(createContext(), NO_EVENTS);
    const input = {
      instruction: "Post the reminder.",
      trigger: {
        type: "schedule" as const,
        schedule: {
          kind: "one_off" as const,
          timing: {
            type: "after" as const,
            value: 1,
            unit: "minute" as const,
          },
        },
      },
    };

    const first = await executeTool(tool, input, {
      toolCallId: "call-create-first",
    });
    const second = await executeTool(tool, input, {
      toolCallId: "call-create-second",
    });

    expect(second.automation.id).not.toBe(first.automation.id);
    await expect(
      listScheduledAutomationsForTeam(TEST_TEAM_ID),
    ).resolves.toHaveLength(2);
  });

  it("does not store Slack ids as creator display identity", async () => {
    const created = (await createTask(
      createContext({
        actor: {
          platform: "slack",
          teamId: TEST_TEAM_ID,
          userId: "U039RR91S",
          userName: "unknown",
          fullName: "W039RR91S",
        },
      }),
    )) as { automation: { id: string } };

    await expect(
      readScheduledAutomation(created.automation.id),
    ).resolves.toEqual(
      expect.objectContaining({
        createdBy: {
          slackUserId: "U039RR91S",
        },
      }),
    );
  });

  it("rejects synthetic unknown actor ids before creating a task", async () => {
    const rejected = createTask(
      createContext({
        actor: {
          platform: "slack",
          teamId: TEST_TEAM_ID,
          userId: "unknown",
          userName: "unknown",
          fullName: "unknown",
        },
      }),
    );

    await expect(rejected).rejects.toThrow(ToolInputError);
    await expect(rejected).rejects.toThrow(
      "Automation tools need a Turn that a person started.",
    );
    await expect(
      listScheduledAutomationsForTeam(TEST_TEAM_ID),
    ).resolves.toEqual([]);
  });

  it("rejects an invalid Slack workspace before creating a task", async () => {
    const rejected = executeTool(
      createAutomationTool(createContext({ teamId: "D123" }), NO_EVENTS),
      {
        instruction: "Reminder: Remind David to wash his hands.",
        trigger: {
          type: "schedule",
          schedule: {
            kind: "one_off",
            timing: { type: "after", value: 1, unit: "minute" },
          },
        },
        credentialMode: null,
      },
    );

    await expect(rejected).rejects.toThrow(ToolInputError);
    await expect(rejected).rejects.toThrow(
      "This Conversation has no channel or DM that an Automation can deliver to.",
    );
    await expect(
      listScheduledAutomationsForTeam(TEST_TEAM_ID),
    ).resolves.toEqual([]);
  });

  it("rejects invalid scheduled automation routing context at the store boundary", async () => {
    await createTask();
    const task = (await listScheduledAutomations()).at(0);
    if (!task) {
      throw new Error("Expected scheduled automation to be created");
    }

    await expect(
      saveScheduledAutomation(schedulerDb(), {
        ...task,
        id: "sched_bad_destination",
        destination: {
          platform: "slack",
          teamId: "0BADTEAM",
          channelId: "D123",
        },
      }),
    ).rejects.toThrow("Scheduled automation routing context is invalid.");
    await expect(
      readScheduledAutomation("sched_bad_destination"),
    ).resolves.toBe(undefined);

    await expect(
      saveScheduledAutomation(schedulerDb(), {
        ...task,
        id: "sched_thread_destination",
        destination: {
          ...task.destination,
          threadTs: "1700000000.000100",
        } as ScheduledAutomation["destination"],
      }),
    ).rejects.toThrow("Scheduled automation routing context is invalid.");

    await expect(
      saveScheduledAutomation(schedulerDb(), {
        ...task,
        id: "sched_bad_credentialMode",
        credentialMode: "invalid" as ScheduledAutomation["credentialMode"],
      }),
    ).rejects.toThrow("Scheduled automation routing context is invalid.");
    await expect(
      readScheduledAutomation("sched_bad_credentialMode"),
    ).resolves.toBe(undefined);

    await expect(
      saveScheduledAutomation(schedulerDb(), {
        ...task,
        id: "sched_bad_creator",
        createdBy: { slackUserId: "unknown" },
      }),
    ).rejects.toThrow("Scheduled automation routing context is invalid.");
    await expect(readScheduledAutomation("sched_bad_creator")).resolves.toBe(
      undefined,
    );
  });

  it("computes relative one-off runs from the trusted clock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T00:24:23.000Z"));

    const result = await executeTool(
      createAutomationTool(
        createContext({
          channelId: "D123",
          now: () => Date.now(),
          userText: "remind me in 1 minute to wash my hands",
        }),
        NO_EVENTS,
      ),
      {
        instruction: "Wash hands reminder: Remind David to wash his hands.",
        trigger: {
          type: "schedule",
          schedule: {
            kind: "one_off",
            timing: { type: "after", value: 1, unit: "minute" },
          },
        },
      },
    );

    expect(result).toMatchObject({
      automation: {
        nextRunAt: "2026-05-27T00:25:23.000Z",
        schedule: "In 1 minute",
        status: "active",
        instruction: "Wash hands reminder: Remind David to wash his hands.",
      },
      objectCards: [
        {
          trigger: "May 26, 2026, 5:25 PM · America/Los_Angeles",
        },
      ],
    });
    await expect(
      listScheduledAutomationsForTeam(TEST_TEAM_ID),
    ).resolves.toMatchObject([
      {
        conversationAccess: {
          audience: "direct",
          visibility: "private",
        },
        credentialMode: "creator",
        destination: { channelId: "D123" },
        nextRunAtMs: Date.parse("2026-05-27T00:25:23.000Z"),
        status: "active",
      },
    ]);
  });

  it("rejects malformed local dates", async () => {
    await expect(
      createTask(createContext(), {
        trigger: {
          type: "schedule",
          schedule: {
            kind: "one_off",
            timing: { type: "at", date: "05/25/2026", time: "09:00" },
          },
        },
      }),
    ).rejects.toThrow("Use a local date in YYYY-MM-DD format.");
    await expect(
      listScheduledAutomationsForTeam(TEST_TEAM_ID),
    ).resolves.toEqual([]);
  });

  it("rejects missing structured schedules with a tool error", async () => {
    await expect(
      createTask(createContext(), {
        trigger: { type: "schedule", schedule: undefined },
      }),
    ).rejects.toThrow("schedule");
    await expect(
      listScheduledAutomationsForTeam(TEST_TEAM_ID),
    ).resolves.toEqual([]);
  });

  it("rejects unsupported recurring frequencies", async () => {
    await expect(
      createTask(createContext(), {
        trigger: {
          type: "schedule",
          schedule: {
            kind: "recurring",
            frequency: "hourly",
            time: "09:00",
          },
        },
      }),
    ).rejects.toThrow("Invalid tool arguments: trigger.schedule");
    await expect(
      listScheduledAutomationsForTeam(TEST_TEAM_ID),
    ).resolves.toEqual([]);
  });

  it("rejects removed top-level scheduling fields", async () => {
    await expect(
      createTask(createContext(), {
        nextRunAt: "2026-05-25T16:00:00.000Z",
      }),
    ).rejects.toThrow("Unrecognized key");
    await expect(
      listScheduledAutomationsForTeam(TEST_TEAM_ID),
    ).resolves.toEqual([]);
  });

  it("rejects weekly schedules without weekdays", async () => {
    await expect(
      createTask(createContext(), {
        trigger: {
          type: "schedule",
          schedule: {
            kind: "recurring",
            frequency: "weekly",
            time: "09:00",
          },
        },
      }),
    ).rejects.toThrow("Weekly schedules require weekdays.");
    await expect(
      listScheduledAutomationsForTeam(TEST_TEAM_ID),
    ).resolves.toEqual([]);
  });

  it("rejects recurring fields that contradict the selected frequency", async () => {
    await expect(
      createTask(createContext(), {
        trigger: {
          type: "schedule",
          schedule: {
            kind: "recurring",
            frequency: "daily",
            time: "09:00",
            weekdays: ["monday"],
          },
        },
      }),
    ).rejects.toThrow("weekdays applies only to weekly schedules.");
    await expect(
      listScheduledAutomationsForTeam(TEST_TEAM_ID),
    ).resolves.toEqual([]);
  });

  it("edits and deletes a task from the same Slack destination", async () => {
    const context = createContext();
    const created = (await createTask(context)) as {
      automation: { id: string };
    };
    const taskId = created.automation.id;

    const updated = await executeTool(
      createUpdateAutomationTool(context, NO_EVENTS),
      {
        automationId: taskId,
        instruction:
          "Tuesday scheduler digest: Summarize open scheduler issues.",
        trigger: {
          type: "schedule",
          schedule: {
            kind: "recurring",
            frequency: "weekly",
            time: "10:00",
            weekdays: ["tuesday"],
          },
        },
      },
    );
    expect(updated).toMatchObject({
      automation: {
        id: taskId,
        nextRunAt: "2026-05-26T17:00:00.000Z",
        instruction:
          "Tuesday scheduler digest: Summarize open scheduler issues.",
        schedule: "Every week on Tuesday at 10:00 (America/Los_Angeles)",
      },
    });
    await expect(readScheduledAutomation(taskId)).resolves.toMatchObject({
      nextRunAtMs: Date.parse("2026-05-26T17:00:00.000Z"),
      schedule: {
        recurrence: {
          frequency: "weekly",
          time: { hour: 10, minute: 0 },
          weekdays: [2],
        },
      },
    });

    const deleted = await executeTool(
      createDeleteAutomationTool(context, NO_EVENTS),
      {
        automationId: taskId,
      },
    );
    expect(deleted).not.toHaveProperty("cards");
    expect(deleted).toMatchObject({
      automation: {
        id: taskId,
        status: "deleted",
      },
    });

    const listed = await executeTool(
      createSearchAutomationsTool(context, NO_EVENTS),
      {},
    );
    expect(listed).toMatchObject({ automations: [] });
  });

  it("treats a null update schedule as omitted", async () => {
    const context = createContext();
    const created = (await createTask(context)) as {
      automation: { id: string; nextRunAt: string; instruction: string };
    };

    const updated = await executeTool(
      createUpdateAutomationTool(context, NO_EVENTS),
      {
        automationId: created.automation.id,
        trigger: null,
        instruction: `${created.automation.instruction} (edited)`,
      },
    );

    expect(updated).toMatchObject({
      automation: {
        id: created.automation.id,
        nextRunAt: created.automation.nextRunAt,
        status: "active",
        instruction: `${created.automation.instruction} (edited)`,
      },
    });
  });

  it("rejects removed top-level rescheduling fields", async () => {
    const context = createContext();
    const created = (await createTask(context)) as {
      automation: { id: string };
    };
    const tool = createUpdateAutomationTool(context, NO_EVENTS);

    await expect(
      executeTool(tool, {
        automationId: created.automation.id,
        nextRunAt: "2026-06-01T16:00:00.000Z",
      } as Parameters<NonNullable<typeof tool.execute>>[0]),
    ).rejects.toThrow("Unrecognized key");
    await expect(
      readScheduledAutomation(created.automation.id),
    ).resolves.toMatchObject({
      nextRunAtMs: Date.parse("2026-05-25T16:00:00.000Z"),
    });
  });

  it("rejects edits with an unsupported recurring frequency", async () => {
    const context = createContext();
    const created = (await createTask(context)) as {
      automation: { id: string };
    };
    const updateTool = createUpdateAutomationTool(context, NO_EVENTS);

    await expect(
      executeTool(updateTool, {
        automationId: created.automation.id,
        trigger: {
          type: "schedule",
          schedule: {
            kind: "recurring",
            frequency: "hourly",
            time: "09:00",
          },
        },
      } as Parameters<NonNullable<typeof updateTool.execute>>[0]),
    ).rejects.toThrow("Invalid tool arguments: trigger.schedule");
    await expect(
      readScheduledAutomation(created.automation.id),
    ).resolves.toMatchObject({
      schedule: {
        description: "Every week on Monday at 09:00 (America/Los_Angeles)",
      },
    });
  });

  it("converts recurring tasks to one-off tasks with a full schedule replacement", async () => {
    const context = createContext();
    const created = (await createTask(context)) as {
      automation: { id: string };
    };

    const updated = await executeTool(
      createUpdateAutomationTool(context, NO_EVENTS),
      {
        automationId: created.automation.id,
        trigger: {
          type: "schedule",
          schedule: {
            kind: "one_off",
            timing: { type: "at", date: "2026-06-01", time: "09:00" },
          },
        },
      },
    );

    expect(updated).toMatchObject({
      automation: {
        id: created.automation.id,
        nextRunAt: "2026-06-01T16:00:00.000Z",
        recurrence: null,
        schedule: "Once on 2026-06-01 at 09:00 (America/Los_Angeles)",
      },
    });
    await expect(
      readScheduledAutomation(created.automation.id),
    ).resolves.toMatchObject({
      schedule: {
        kind: "one_off",
      },
    });
  });

  it("lets anyone in the workspace manage a public-channel task from another channel", async () => {
    const created = (await createTask(createContext())) as {
      automation: { id: string };
    };
    const automationId = created.automation.id;
    // The dashboard reads Destination visibility from the directory.
    await getConversationStore().recordActivity({
      conversationId: "slack:C123:schedule-public",
      destination: {
        platform: "slack",
        teamId: TEST_TEAM_ID,
        channelId: "C123",
      },
      nowMs: Date.now(),
      visibility: "public",
    });
    const creatorElsewhere = createContext({ channelId: "C999" });
    const readerElsewhere = createContext({
      channelId: "C999",
      actor: slackActor("U999"),
    });

    await expect(
      executeTool(createUpdateAutomationTool(creatorElsewhere, NO_EVENTS), {
        automationId,
        trigger: {
          type: "schedule",
          schedule: {
            kind: "recurring",
            frequency: "daily",
            time: "09:00",
            timezone: "America/Los_Angeles",
          },
        },
      }),
    ).resolves.toMatchObject({
      automation: {
        destination: { channel: "C123" },
        schedule: "Every day at 09:00 (America/Los_Angeles)",
      },
    });
    await expect(
      executeTool(createRunAutomationNowTool(creatorElsewhere, NO_EVENTS), {
        automationId,
      }),
    ).resolves.toMatchObject({
      automation: { id: automationId, runNowAt: expect.any(String) },
    });

    // Anyone in the workspace can find and manage a public-channel task.
    await expect(
      executeTool(createSearchAutomationsTool(readerElsewhere, NO_EVENTS), {
        query: automationId,
      }),
    ).resolves.toMatchObject({
      automations: [{ id: automationId, isCreator: false }],
    });
    await expect(
      executeTool(createUpdateAutomationTool(readerElsewhere, NO_EVENTS), {
        automationId,
        destination: "current_conversation",
      }),
    ).rejects.toThrow("Only the automation creator can move this automation.");
    // Only the creator can start work with the creator's credentials.
    await expect(
      executeTool(createRunAutomationNowTool(readerElsewhere, NO_EVENTS), {
        automationId,
      }),
    ).rejects.toThrow("Only the creator can resume it or run it now.");
    await expect(
      executeTool(createUpdateAutomationTool(readerElsewhere, NO_EVENTS), {
        automationId,
        instruction: "Team digest: Summarize open scheduler issues.",
      }),
    ).resolves.toMatchObject({
      automation: {
        credentialMode: "system",
        instruction: "Team digest: Summarize open scheduler issues.",
      },
    });
    for (const status of ["paused", "active"] as const) {
      await expect(
        executeTool(createUpdateAutomationTool(readerElsewhere, NO_EVENTS), {
          automationId,
          status,
        }),
      ).resolves.toMatchObject({ automation: { status } });
    }
    await expect(
      executeTool(createRunAutomationNowTool(readerElsewhere, NO_EVENTS), {
        automationId,
      }),
    ).resolves.toMatchObject({ automation: { runNowAt: expect.any(String) } });
    await expect(
      executeTool(createDeleteAutomationTool(readerElsewhere, NO_EVENTS), {
        automationId,
      }),
    ).resolves.toMatchObject({
      automation: { id: automationId, status: "deleted" },
    });
  });

  it("binds tasks to the raw conversation channel, not the assistant context channel", async () => {
    // The scheduler receives an active Source built from the raw conversation
    // channel by runtime wiring. Management works from any context with the
    // same source conversation.
    //
    // In practice: a DM opened via Slack’s “Ask Junior” panel from #js-alerts
    // has getPluginTools build source.channelId = DDM rather than using
    // the outbound assistant-context channel. Both creation and management
    // from that DM use DDM, so the stored task destination never drifts.
    const dmCtx = createContext({ channelId: "DDM" });
    const created = (await createTask(dmCtx)) as { automation: { id: string } };
    const taskId = created.automation.id;

    // Task is bound to the DM channel, not any assistant source channel.
    await expect(readScheduledAutomation(taskId)).resolves.toMatchObject({
      destination: { channelId: "DDM" },
    });

    // Any context that resolves to the same DM channel can list and manage.
    const listed = await executeTool(
      createSearchAutomationsTool(
        createContext({ channelId: "DDM" }),
        NO_EVENTS,
      ),
      {},
    );
    expect(listed).toMatchObject({
      automations: [{ id: taskId }],
    });

    const deleted = await executeTool(
      createDeleteAutomationTool(
        createContext({ channelId: "DDM" }),
        NO_EVENTS,
      ),
      { automationId: taskId },
    );
    expect(deleted).toMatchObject({
      automation: { id: taskId, status: "deleted" },
    });
  });

  it("keeps private tasks to their channel and their creator", async () => {
    // A task created in Alice’s DM cannot be managed by Bob from Bob’s DM.
    const created = (await createTask(
      createContext({ channelId: "DALICE" }),
    )) as { automation: { id: string } };
    const bob = createContext({ channelId: "DBOB", actor: slackActor("U999") });
    const noAccess = "Automation was not found.";

    await expect(
      executeTool(createUpdateAutomationTool(bob, NO_EVENTS), {
        automationId: created.automation.id,
        instruction: "Wrong channel edit.",
      }),
    ).rejects.toThrow(noAccess);
    await expect(
      executeTool(createDeleteAutomationTool(bob, NO_EVENTS), {
        automationId: created.automation.id,
      }),
    ).rejects.toThrow(noAccess);
    await expect(
      executeTool(
        createDeleteAutomationTool(
          createContext({ channelId: "DBOB" }),
          NO_EVENTS,
        ),
        { automationId: created.automation.id },
      ),
    ).resolves.toMatchObject({ automation: { status: "deleted" } });
  });

  it("allows another actor to manage tasks in the same Slack destination", async () => {
    const context = createContext();
    const created = (await createTask(context)) as {
      automation: { id: string };
    };
    const otherActor = createContext({
      actor: {
        platform: "slack",
        teamId: TEST_TEAM_ID,
        userId: "U999",
        userName: "alice",
        fullName: "Alice Reviewer",
      },
    });

    await expect(
      executeTool(createUpdateAutomationTool(otherActor, NO_EVENTS), {
        automationId: created.automation.id,
        outcomes: [],
      }),
    ).rejects.toThrow(
      "Only the scheduled automation creator can change message destinations.",
    );

    const updated = await executeTool(
      createUpdateAutomationTool(otherActor, NO_EVENTS),
      {
        automationId: created.automation.id,
        instruction: "Team-owned digest: Summarize open scheduler issues.",
      },
    );
    const deleted = await executeTool(
      createDeleteAutomationTool(otherActor, NO_EVENTS),
      {
        automationId: created.automation.id,
      },
    );

    expect(updated).toMatchObject({
      automation: {
        id: created.automation.id,
        instruction: "Team-owned digest: Summarize open scheduler issues.",
      },
    });
    expect(deleted).toMatchObject({
      automation: {
        id: created.automation.id,
        status: "deleted",
      },
    });
    await expect(
      readScheduledAutomation(created.automation.id),
    ).resolves.toMatchObject({
      status: "deleted",
      executionActor: {
        platform: "system",
        name: "scheduled-automation",
      },
      task: {
        text: "Team-owned digest: Summarize open scheduler issues.",
      },
    });
  });

  it("stores creator credential mode by default in channels", async () => {
    const created = await createTask(createContext());

    expect(created).toMatchObject({
      automation: { credentialMode: "creator" },
    });
    await expect(
      listScheduledAutomationsForTeam(TEST_TEAM_ID),
    ).resolves.toMatchObject([
      {
        createdBy: { slackUserId: "U123" },
        credentialMode: "creator",
        destination: { channelId: "C123" },
      },
    ]);
  });

  it("accepts explicit creator credential mode when creating a task", async () => {
    const context = createContext();
    const tool = createAutomationTool(context, NO_EVENTS);
    const input = {
      instruction: "Weekly issue digest: Summarize open scheduler issues.",
      trigger: {
        type: "schedule" as const,
        schedule: {
          kind: "recurring" as const,
          frequency: "weekly" as const,
          time: "09:00",
          weekdays: ["monday" as const],
          timezone: "America/Los_Angeles",
        },
      },
      credentialMode: "creator" as const,
    };

    expect(tool.prepareArguments?.(input)).not.toHaveProperty("credentialMode");
    expect(
      tool.prepareArguments?.({ ...input, credentialMode: null }),
    ).not.toHaveProperty("credentialMode");
    expect(
      tool.prepareArguments?.({ ...input, credentialMode: "system" }),
    ).toHaveProperty("credentialMode", "system");
    const created = await executeTool(tool, input);

    expect(created).toMatchObject({
      automation: { credentialMode: "creator" },
    });
  });

  it("keeps creator credentials to runs the creator authorized", async () => {
    const context = createContext();
    const created = (await createTask(context)) as {
      automation: { id: string };
    };
    const automationId = created.automation.id;
    const otherActor = createContext({ actor: slackActor("U999") });

    await executeTool(createUpdateAutomationTool(otherActor, NO_EVENTS), {
      automationId,
      instruction:
        "Weekly issue digest: Summarize open scheduler issues and post a concise summary.",
    });
    await expect(readScheduledAutomation(automationId)).resolves.toMatchObject({
      credentialMode: "creator",
    });
    await expect(
      executeTool(createRunAutomationNowTool(otherActor, NO_EVENTS), {
        automationId,
      }),
    ).rejects.toThrow(
      "This scheduled automation uses its creator's credentials. Only the creator can resume it or run it now.",
    );

    // A new Schedule changes when the creator's accounts run.
    await executeTool(createUpdateAutomationTool(otherActor, NO_EVENTS), {
      automationId,
      trigger: {
        type: "schedule",
        schedule: {
          kind: "recurring",
          frequency: "weekly",
          time: "09:00",
          weekdays: ["tuesday"],
          timezone: "America/Los_Angeles",
        },
      },
    });
    await expect(readScheduledAutomation(automationId)).resolves.toMatchObject({
      credentialMode: "system",
    });
    await expect(
      executeTool(createRunAutomationNowTool(otherActor, NO_EVENTS), {
        automationId,
      }),
    ).resolves.toMatchObject({
      automation: { credentialMode: "system", runNowAt: expect.any(String) },
    });
  });

  it("updates credential availability and allows only the creator to enable it", async () => {
    const context = createContext();
    const created = await createTask(context);
    expect(created).toMatchObject({
      automation: { credentialMode: "creator" },
    });
    const taskId = (created as { automation: { id: string } }).automation.id;
    const original = await readScheduledAutomation(taskId);
    if (!original) {
      throw new Error("Expected scheduled automation to exist");
    }
    const otherActor = createContext({
      actor: {
        platform: "slack",
        teamId: TEST_TEAM_ID,
        userId: "U999",
      },
    });

    await expect(
      executeTool(createUpdateAutomationTool(otherActor, NO_EVENTS), {
        automationId: taskId,
        credentialMode: "system",
      }),
    ).resolves.toMatchObject({
      automation: { credentialMode: "system" },
    });
    await expect(readScheduledAutomation(taskId)).resolves.toMatchObject({
      credentialMode: "system",
      destination: original.destination,
      nextRunAtMs: original.nextRunAtMs,
      schedule: original.schedule,
      status: original.status,
      task: original.task,
    });

    await expect(
      executeTool(createUpdateAutomationTool(otherActor, NO_EVENTS), {
        automationId: taskId,
        credentialMode: "creator",
      }),
    ).rejects.toThrow(
      "Only the scheduled automation creator can enable creator credential use.",
    );

    await expect(
      executeTool(createUpdateAutomationTool(context, NO_EVENTS), {
        automationId: taskId,
        credentialMode: "creator",
      }),
    ).resolves.toMatchObject({
      automation: { credentialMode: "creator" },
    });
  });

  it("rejects creator identity from another Slack workspace", async () => {
    await expect(
      createTask(
        createContext({
          actor: {
            platform: "slack",
            teamId: "TOTHER",
            userId: "U123",
          },
        }),
      ),
    ).rejects.toThrow("Automation tools need a Turn that a person started.");
  });

  it("makes creator credentials available in private group conversations", async () => {
    const result = await createTask(createContext({ channelId: "G123" }));

    expect(result).toMatchObject({
      automation: {
        conversationAccess: {
          audience: "group",
          visibility: "private",
        },
        credentialMode: "creator",
      },
    });
    const tasks = await listScheduledAutomationsForTeam(TEST_TEAM_ID);
    expect(tasks).toMatchObject([
      {
        conversationAccess: {
          audience: "group",
          visibility: "private",
        },
        destination: { channelId: "G123" },
      },
    ]);
    expect(tasks[0]?.credentialMode).toBe("creator");
  });

  it("stores the canonical channel of a Slack channel reference", async () => {
    const context = createContext({
      channelId: "D123",
      source: {
        ...createSlackSource({
          teamId: TEST_TEAM_ID,
          channelId: "D123",
          visibility: "private",
        }),
        channelId: "slack:D123:1700000000.000",
      },
    });
    await createTask(context, {
      trigger: {
        type: "schedule",
        schedule: {
          kind: "one_off",
          timing: { type: "after", value: 1, unit: "minute" },
        },
      },
    });
    await expect(
      listScheduledAutomationsForTeam(TEST_TEAM_ID),
    ).resolves.toMatchObject([{ destination: { channelId: "D123" } }]);
  });

  it("stores canonical Slack destinations directly", async () => {
    const result = await createTask(createContext({ channelId: "D123" }), {
      trigger: {
        type: "schedule",
        schedule: {
          kind: "one_off",
          timing: { type: "after", value: 1, unit: "minute" },
        },
      },
    });

    expect(result).toMatchObject({
      automation: {
        conversationAccess: {
          audience: "direct",
          visibility: "private",
        },
      },
    });
    await expect(
      listScheduledAutomationsForTeam(TEST_TEAM_ID),
    ).resolves.toMatchObject([
      {
        destination: { channelId: "D123" },
      },
    ]);
  });

  it("uses the creator's Slack timezone and saves it on the user", async () => {
    queueSlackTimezone("UNEWYORK", "America/New_York");
    await insertUser("UNEWYORK", "Europe/Vienna");

    const created = await createTask(
      createContext({ actor: slackActor("UNEWYORK") }),
      {
        trigger: {
          type: "schedule",
          schedule: {
            kind: "one_off",
            timezone: null,
            timing: { type: "at", date: "2026-05-26", time: "09:00" },
          },
        },
      },
    );

    expect(created).toMatchObject({
      automation: {
        nextRunAt: "2026-05-26T13:00:00.000Z",
        recurrence: null,
        timezone: "America/New_York",
      },
    });
    await expect(
      readUserTimezone(schedulerDb(), "user:UNEWYORK"),
    ).resolves.toBe("America/New_York");
  });

  it("uses the saved user timezone when Slack has no valid timezone", async () => {
    queueSlackTimezone("UVIENNA", "Not/AZone");
    await insertUser("UVIENNA", "Europe/Vienna");

    const created = await createTask(
      createContext({ actor: slackActor("UVIENNA") }),
      {
        trigger: {
          type: "schedule",
          schedule: {
            kind: "one_off",
            timing: { type: "at", date: "2026-05-26", time: "09:00" },
          },
        },
      },
    );

    expect(created).toMatchObject({
      automation: {
        nextRunAt: "2026-05-26T07:00:00.000Z",
        timezone: "Europe/Vienna",
      },
    });
    await expect(readUserTimezone(schedulerDb(), "user:UVIENNA")).resolves.toBe(
      "Europe/Vienna",
    );
  });

  it("uses JUNIOR_TIMEZONE when the creator has no timezone", async () => {
    process.env.JUNIOR_TIMEZONE = "America/New_York";
    queueSlackTimezone("UNOZONE", "");

    const created = await createTask(
      createContext({ actor: slackActor("UNOZONE"), linkedUser: false }),
      {
        trigger: {
          type: "schedule",
          schedule: {
            kind: "one_off",
            timing: { type: "at", date: "2026-05-26", time: "09:00" },
          },
        },
      },
    );

    expect(created).toMatchObject({
      automation: {
        nextRunAt: "2026-05-26T13:00:00.000Z",
        recurrence: null,
        timezone: "America/New_York",
      },
    });
  });

  it("rejects invalid default timezones", async () => {
    process.env.JUNIOR_TIMEZONE = "not/a-zone";
    queueSlackTimezone("UBADDEFAULT", "");

    await expect(
      createTask(createContext({ actor: slackActor("UBADDEFAULT") }), {
        trigger: {
          type: "schedule",
          schedule: {
            kind: "one_off",
            timing: { type: "after", value: 1, unit: "minute" },
          },
        },
      }),
    ).rejects.toThrow("timezone must be a valid IANA time zone.");
    await expect(
      listScheduledAutomationsForTeam(TEST_TEAM_ID),
    ).resolves.toEqual([]);
  });

  it("preserves a recurring task calendar anchor on content-only edits", async () => {
    const context = createContext();
    const created = (await createTask(context)) as {
      automation: { id: string };
    };
    const task = await readScheduledAutomation(created.automation.id);
    expect(task?.schedule.recurrence).toMatchObject({
      interval: 1,
      startDate: "2026-05-25",
    });
    await saveScheduledAutomation(schedulerDb(), {
      ...task!,
      nextRunAtMs: Date.parse("2026-06-08T16:00:00.000Z"),
      updatedAtMs: Date.parse("2026-05-26T16:00:00.000Z"),
    });

    const updated = await executeTool(
      createUpdateAutomationTool(context, NO_EVENTS),
      {
        automationId: created.automation.id,
        instruction: "Renamed issue digest: Summarize open scheduler issues.",
      },
    );

    expect(updated).toMatchObject({
      automation: {
        instruction: "Renamed issue digest: Summarize open scheduler issues.",
      },
    });
    await expect(
      readScheduledAutomation(created.automation.id),
    ).resolves.toMatchObject({
      nextRunAtMs: Date.parse("2026-06-08T16:00:00.000Z"),
      schedule: {
        recurrence: {
          interval: 1,
          startDate: "2026-05-25",
        },
      },
    });
  });

  it("clears stale block reasons when resuming a task", async () => {
    const context = createContext();
    const created = (await createTask(context)) as {
      automation: { id: string };
    };
    const task = await readScheduledAutomation(created.automation.id);
    expect(task).toBeDefined();
    await saveScheduledAutomation(schedulerDb(), {
      ...task!,
      status: "blocked",
      statusReason: "Missing GitHub credentials.",
      updatedAtMs: Date.parse("2026-05-25T16:01:00.000Z"),
    });

    const updated = await executeTool(
      createUpdateAutomationTool(context, NO_EVENTS),
      {
        automationId: created.automation.id,
        status: "active",
      },
    );

    expect(updated).toMatchObject({
      automation: {
        id: created.automation.id,
        status: "active",
      },
    });
    const resumed = await readScheduledAutomation(created.automation.id);
    expect(resumed).toMatchObject({
      status: "active",
    });
    expect(resumed?.statusReason).toBeUndefined();
  });

  it("marks an active task due immediately without changing its scheduled next run", async () => {
    const context = createContext();
    const created = (await createTask(context)) as {
      automation: { id: string };
    };
    const task = await readScheduledAutomation(created.automation.id);
    expect(task).toBeDefined();
    const scheduledNextRunAtMs = Date.parse("2026-06-01T16:00:00.000Z");
    await saveScheduledAutomation(schedulerDb(), {
      ...task!,
      nextRunAtMs: scheduledNextRunAtMs,
      updatedAtMs: Date.parse("2026-05-25T16:01:00.000Z"),
    });

    const beforeMs = Date.now();
    const result = await executeTool(
      createRunAutomationNowTool(context, NO_EVENTS),
      {
        automationId: created.automation.id,
      },
    );
    const afterMs = Date.now();

    expect(result).toMatchObject({
      automation: {
        id: created.automation.id,
        status: "active",
        nextRunAt: "2026-06-01T16:00:00.000Z",
      },
    });
    const due = await readScheduledAutomation(created.automation.id);
    expect(due).toMatchObject({
      status: "active",
      nextRunAtMs: scheduledNextRunAtMs,
      destination: {
        teamId: context.destination?.teamId,
        channelId: context.destination?.channelId,
      },
      createdBy: {
        slackUserId: context.actor?.userId,
      },
    });
    expect(due?.statusReason).toBeUndefined();
    expect(due?.runNowAtMs).toBeGreaterThanOrEqual(beforeMs);
    expect(due?.runNowAtMs).toBeLessThanOrEqual(afterMs);

    await expect(
      claimDueScheduledRun(schedulerDb(), { nowMs: afterMs }),
    ).resolves.toMatchObject({
      taskId: created.automation.id,
      scheduledForMs: due?.runNowAtMs,
      status: "pending",
    });
  });

  it("does not run-now a blocked task", async () => {
    const context = createContext();
    const created = (await createTask(context)) as {
      automation: { id: string };
    };
    const task = await readScheduledAutomation(created.automation.id);
    expect(task).toBeDefined();
    await saveScheduledAutomation(schedulerDb(), {
      ...task!,
      status: "blocked",
      statusReason: "Blocked until credentials are available.",
      updatedAtMs: Date.parse("2026-05-25T16:01:00.000Z"),
    });

    await expect(
      executeTool(createRunAutomationNowTool(context, NO_EVENTS), {
        automationId: created.automation.id,
      }),
    ).rejects.toThrow(
      "Scheduled automation must be active before it can be run now.",
    );
    const blocked = await readScheduledAutomation(created.automation.id);
    expect(blocked).toMatchObject({
      status: "blocked",
      statusReason: "Blocked until credentials are available.",
    });
    expect(blocked?.runNowAtMs).toBeUndefined();
  });

  it("removes deleted tasks from scheduler listings", async () => {
    const context = createContext();
    const created = (await createTask(context)) as {
      automation: { id: string };
    };

    await executeTool(createDeleteAutomationTool(context, NO_EVENTS), {
      automationId: created.automation.id,
    });

    await expect(
      listScheduledAutomationsForTeam(TEST_TEAM_ID),
    ).resolves.toEqual([]);
  });

  it("claims due runs idempotently", async () => {
    const context = createContext();
    const created = (await createTask(context)) as {
      automation: { id: string };
    };
    const task = await readScheduledAutomation(created.automation.id);
    expect(task).toBeDefined();
    await saveScheduledAutomation(schedulerDb(), {
      ...task!,
      nextRunAtMs: 1000,
      updatedAtMs: 1000,
    });

    const first = await claimDueScheduledRun(schedulerDb(), { nowMs: 2000 });
    const second = await claimDueScheduledRun(schedulerDb(), { nowMs: 2000 });

    expect(first).toMatchObject({
      taskId: created.automation.id,
      scheduledForMs: 1000,
      status: "pending",
    });
    expect(second).toBeUndefined();

    // A finished run whose advance was not saved must not stop the task.
    await markScheduledRunFailed(schedulerDb(), {
      completedAtMs: 2000,
      errorMessage: "Dispatch failed.",
      runId: first!.id,
    });
    await claimDueScheduledRun(schedulerDb(), { nowMs: 3000 });
    await expect(
      readScheduledAutomation(created.automation.id),
    ).resolves.toMatchObject({ lastRunAtMs: 1000, status: "active" });
  });

  it("searches the requester's tasks and the active conversation", async () => {
    const creator = createContext({ channelId: "CSOURCE" });
    const otherChannel = createContext({ channelId: "COTHER" });
    const otherActor = createContext({
      channelId: "CSOURCE",
      actor: {
        platform: "slack",
        teamId: TEST_TEAM_ID,
        userId: "U999",
        userName: "bob",
        fullName: "Bob Example",
      },
    });

    const mine = (await createTask(creator, {
      instruction: "Weekly planning reminder: post the agenda here.",
    })) as { automation: { id: string } };
    await createTask(otherChannel, {
      instruction: "Weekly planning reminder: post the agenda here.",
    });
    const theirs = (await createTask(otherActor, {
      instruction: "Someone else's planning reminder.",
    })) as { automation: { id: string } };

    const ids = (result: { automations: Array<{ id: string }> }) =>
      result.automations.map((task) => task.id).sort();
    // By default, search finds the requester's tasks and every task here.
    const all = await executeTool(
      createSearchAutomationsTool(creator, NO_EVENTS),
      {},
    );
    expect(ids(all)).toHaveLength(3);
    expect(all).toMatchObject({ truncated: false });
    const here = await executeTool(
      createSearchAutomationsTool(creator, NO_EVENTS),
      { scope: "current_conversation" },
    );
    expect(ids(here)).toEqual(
      [mine.automation.id, theirs.automation.id].sort(),
    );
    const own = await executeTool(
      createSearchAutomationsTool(otherActor, NO_EVENTS),
      { scope: "mine" },
    );
    expect(ids(own)).toEqual([theirs.automation.id]);

    const found = await executeTool(
      createSearchAutomationsTool(
        createContext({ channelId: "CTARGET" }),
        NO_EVENTS,
      ),
      {
        destination: `${TEST_TEAM_ID}:CSOURCE`,
        query: "planning reminder",
      },
    );

    expect(found).toMatchObject({
      automations: [
        {
          id: mine.automation.id,
          destination: { channel: "CSOURCE" },
          instruction: "Weekly planning reminder: post the agenda here.",
        },
      ],
      truncated: false,
    });

    // An ID or dashboard URL finds the requester's task from any conversation.
    for (const query of [
      mine.automation.id,
      `https://junior.example/automations/${mine.automation.id}`,
    ]) {
      const byId = await executeTool(
        createSearchAutomationsTool(
          createContext({ channelId: "CTARGET" }),
          NO_EVENTS,
        ),
        { query },
      );
      expect(byId.automations.map((task: { id: string }) => task.id)).toEqual([
        mine.automation.id,
      ]);
    }
  });

  it("moves a creator-owned task to the current conversation", async () => {
    const source = createContext({
      channelId: "CSOURCE",
      source: createSlackSource({
        teamId: TEST_TEAM_ID,
        channelId: "CSOURCE",
        threadTs: "1700000000.000100",
        visibility: "public",
      }),
    });
    const created = (await createTask(source, {
      instruction: "Weekly planning reminder: post the agenda here.",
    })) as {
      automation: {
        id: string;
        nextRunAt: string | null;
        schedule: string;
        credentialMode: string;
      };
    };
    await expect(
      readScheduledAutomation(created.automation.id),
    ).resolves.toMatchObject({
      destination: { channelId: "CSOURCE" },
      outcomes: [],
    });
    await executeTool(createUpdateAutomationTool(source, NO_EVENTS), {
      automationId: created.automation.id,
      outcomes: [
        {
          action: "send_message",
          destination: "current_conversation",
        },
      ],
    });

    const publicTarget = createContext({
      channelId: "CTARGET",
      source: createSlackSource({
        teamId: TEST_TEAM_ID,
        channelId: "CTARGET",
        threadTs: "1700000000.000200",
        visibility: "public",
      }),
    });
    const movedPublic = await executeTool(
      createUpdateAutomationTool(publicTarget, NO_EVENTS),
      {
        automationId: created.automation.id,
        destination: "current_conversation",
      },
    );
    expect(movedPublic).toMatchObject({
      automation: {
        id: created.automation.id,
        instruction: "Weekly planning reminder: post the agenda here.",
        schedule: created.automation.schedule,
        nextRunAt: created.automation.nextRunAt,
        credentialMode: "creator",
        destination: { channel: "CTARGET" },
        conversationAccess: {
          audience: "channel",
          visibility: "public",
        },
      },
    });
    await expect(
      readScheduledAutomation(created.automation.id),
    ).resolves.toMatchObject({
      destination: { channelId: "CTARGET" },
      outcomes: [{ destination: { channelId: "CTARGET" } }],
    });

    await expect(
      executeTool(createSearchAutomationsTool(source, NO_EVENTS), {
        scope: "current_conversation",
      }),
    ).resolves.toMatchObject({ automations: [] });
    await expect(
      executeTool(createSearchAutomationsTool(publicTarget, NO_EVENTS), {
        scope: "current_conversation",
      }),
    ).resolves.toMatchObject({
      automations: [{ id: created.automation.id }],
    });

    const privateTarget = createContext({ channelId: "GPRIVATE" });
    const movedPrivate = await executeTool(
      createUpdateAutomationTool(privateTarget, NO_EVENTS),
      {
        automationId: created.automation.id,
        destination: "current_conversation",
      },
    );
    expect(movedPrivate).toMatchObject({
      automation: {
        id: created.automation.id,
        destination: { channel: "GPRIVATE" },
        conversationAccess: {
          audience: "group",
          visibility: "private",
        },
        credentialMode: "creator",
        nextRunAt: created.automation.nextRunAt,
      },
    });
    // The private target's context carries no thread; the move clears it.
    await expect(
      readScheduledAutomation(created.automation.id),
    ).resolves.toMatchObject({
      destination: { channelId: "GPRIVATE" },
      outcomes: [{ destination: { channelId: "GPRIVATE" } }],
    });
    await expect(
      readScheduledAutomation(created.automation.id),
    ).resolves.not.toHaveProperty("destination.threadTs");
    await expect(
      readScheduledAutomation(created.automation.id),
    ).resolves.not.toHaveProperty("outcomes.0.destination.threadTs");

    // Replaying a destination update that already landed is a no-op success.
    await expect(
      executeTool(createUpdateAutomationTool(privateTarget, NO_EVENTS), {
        automationId: created.automation.id,
        destination: "current_conversation",
      }),
    ).resolves.toMatchObject({
      automation: {
        id: created.automation.id,
        destination: { channel: "GPRIVATE" },
      },
    });
  });

  it("rejects unauthorized, cross-workspace, and in-flight destination updates", async () => {
    const source = createContext({ channelId: "CSOURCE" });
    const created = (await createTask(source)) as {
      automation: { id: string };
    };
    const otherActor = createContext({
      channelId: "CTARGET",
      actor: {
        platform: "slack",
        teamId: TEST_TEAM_ID,
        userId: "U999",
        userName: "bob",
        fullName: "Bob Example",
      },
    });

    // The source channel is not public, so others cannot find the task.
    for (const context of [
      otherActor,
      createContext({ channelId: "CTARGET", teamId: "TOTHER" }),
    ]) {
      await expect(
        executeTool(createUpdateAutomationTool(context, NO_EVENTS), {
          automationId: created.automation.id,
          destination: "current_conversation",
        }),
      ).rejects.toThrow("Automation was not found.");
    }

    const task = await readScheduledAutomation(created.automation.id);
    expect(task).toBeDefined();
    await saveScheduledAutomation(schedulerDb(), {
      ...task!,
      nextRunAtMs: 1000,
      updatedAtMs: 1000,
    });
    await expect(
      claimDueScheduledRun(schedulerDb(), { nowMs: 2000 }),
    ).resolves.toMatchObject({
      taskId: created.automation.id,
      status: "pending",
    });

    await expect(
      executeTool(
        createUpdateAutomationTool(
          createContext({ channelId: "CTARGET" }),
          NO_EVENTS,
        ),
        {
          automationId: created.automation.id,
          destination: "current_conversation",
        },
      ),
    ).rejects.toThrow(
      "Scheduled automation cannot be moved while an occurrence is already running",
    );

    await expect(
      readScheduledAutomation(created.automation.id),
    ).resolves.toMatchObject({
      destination: { channelId: "CSOURCE" },
    });
  });
});

describe("Scheduled automation tool wiring via createTools", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
  });

  it("scheduler tools bind to the runtime-owned source", async () => {
    // Verifies that real getPluginTools wiring passes Source through to
    // the scheduler, which stores it as the task destination.
    const previous = setPlugins([]);
    const fixture = await useSchedulerSqlPlugin();
    try {
      const TEAM_ID = `TWIRING${Date.now()}`;
      const identity = {
        id: `identity:${TEAM_ID}:U123`,
        provider: "slack",
        providerSubjectId: "U123",
        providerTenantId: TEAM_ID,
      };
      const user = {
        email: "alice@example.com",
        id: "user:alice",
        identities: [identity],
      };
      const resolveActorIdentity = vi.fn(async () => {
        await storeSlackIdentity(TEAM_ID, "U123");
        return { identity, user };
      });
      const tools = createTools(
        [],
        {},
        {
          conversationId: `slack:DDM:1700000000.100000`,
          source: createSlackSource({
            teamId: TEAM_ID,
            channelId: "DDM",

            visibility: "private",
          }),
          destination: {
            platform: "slack",
            teamId: TEAM_ID,
            channelId: "DDM",
          },
          actor: {
            platform: "slack",
            teamId: TEAM_ID,
            userId: "U123",
            userName: "alice",
            fullName: "Alice",
          },
          egress: {
            async fetch() {
              return new Response("ok");
            },
          },
          resolveActorIdentity,
          workspace: {} as Parameters<typeof getPluginTools>[0]["workspace"],
        },
      );

      expect(tools).toHaveProperty("createAutomation");
      expect(resolveActorIdentity).not.toHaveBeenCalled();

      // Create a task through the real wired tool.
      const result = await executeRegisteredTool<{
        automation: { id: string };
      }>(tools.createAutomation!, {
        instruction: "Wiring test: post a weekly digest.",
        trigger: {
          type: "schedule",
          schedule: {
            kind: "recurring",
            frequency: "weekly",
            time: "09:00",
            weekdays: ["monday"],
            startDate: "2026-06-09",
            timezone: "America/Los_Angeles",
          },
        },
      });

      expect(resolveActorIdentity).toHaveBeenCalledOnce();
      const taskId = result.automation.id;

      // Task destination must be the raw DM channel, NOT the assistant context.
      const stored = await readStoredTask(fixture.sql.db(), taskId);
      expect(stored).toMatchObject({
        destination: { channelId: "DDM", teamId: TEAM_ID },
        conversationAccess: { audience: "direct", visibility: "private" },
      });
      expect(stored?.credentialMode).toBe("creator");
    } finally {
      await fixture.close();
      vi.restoreAllMocks();
      setPlugins(previous);
    }
  });

  it("manages automations from dashboard Conversations", async () => {
    const fixture = await useSchedulerSqlPlugin();
    try {
      const TEAM_ID = `TWEB${Date.now()}`;
      const slackIdentity = await storeSlackIdentity(TEAM_ID, "U123");
      const user = {
        email: "alice@example.com",
        id: "user:alice",
        identities: [
          {
            id: "identity:junior:alice",
            provider: "junior",
            providerSubjectId: "alice@example.com",
          },
          slackIdentity,
        ],
      };
      const webTurn = (conversationId: string) => ({
        conversationId,
        source: createWebSource(conversationId, "public"),
        actor: {
          platform: "web" as const,
          userId: "alice@example.com",
          email: "alice@example.com",
          fullName: "Alice",
        },
        egress: {
          async fetch() {
            return new Response("ok");
          },
        },
        resolveActorIdentity: async () => ({
          identity: user.identities[0]!,
          user,
        }),
        workspace: {} as Parameters<typeof getPluginTools>[0]["workspace"],
      });
      // A dashboard Turn in a Conversation with a Slack Location delivers to
      // that channel. The creator is the person's linked Slack account there.
      const located = createTools([], {}, {
        ...webTurn("slack:DDM:1700000000.100000"),
        location: {
          id: `location:${TEAM_ID}:C123`,
          provider: "slack",
          teamId: TEAM_ID,
          channelId: "C123",
          threadTs: "1700000000.100000",
        },
        destination: { platform: "slack", teamId: TEAM_ID, channelId: "C123" },
      } as ToolRuntimeContext);
      expect(located.createAutomation?.disabledReason).toBeUndefined();
      const created = await executeRegisteredTool<{
        automation: { id: string; isCreator: boolean };
      }>(located.createAutomation!, {
        instruction: "Post the weekly digest.",
        trigger: {
          type: "schedule",
          schedule: {
            kind: "recurring",
            frequency: "weekly",
            time: "09:00",
            weekdays: ["monday"],
            timezone: "America/Los_Angeles",
          },
        },
      });
      expect(created.automation.isCreator).toBe(true);
      await expect(
        readStoredTask(fixture.sql.db(), created.automation.id),
      ).resolves.toMatchObject({
        createdBy: { slackUserId: "U123", fullName: "Alice" },
        creatorIdentityId: slackIdentity.id,
        destination: { teamId: TEAM_ID, channelId: "C123" },
      });

      // A dashboard Conversation with no Location can find and manage it, but
      // cannot create one.
      const conversationId = "test:schedule-cards";
      const unlocated = createTools([], {}, {
        ...webTurn(conversationId),
        destination: { platform: "local", conversationId },
      } as ToolRuntimeContext);
      await expect(
        executeRegisteredTool(unlocated.searchAutomations!, {
          scope: "mine",
        }),
      ).resolves.toMatchObject({
        automations: [{ id: created.automation.id, isCreator: true }],
      });
      await expect(
        executeRegisteredTool(unlocated.updateAutomation!, {
          automationId: created.automation.id,
          title: "Weekly digest",
        }),
      ).resolves.toMatchObject({
        automation: { title: "Weekly digest", credentialMode: "creator" },
      });
      await expect(
        executeRegisteredTool(unlocated.createAutomation!, {
          instruction: "Post another digest.",
          trigger: {
            type: "schedule",
            schedule: {
              kind: "one_off",
              timing: { type: "after", value: 1, unit: "hour" },
            },
          },
        }),
      ).rejects.toThrow(
        "This Conversation has no channel or DM that an Automation can deliver to.",
      );
    } finally {
      await fixture.close();
    }
  });

  it("rejects automation writes from a Turn that no person started", async () => {
    // A child agent result has the person's Slack Actor but an Agent
    // invocation Source. Call the tools directly to check that they refuse it
    // even without the adapter's disabled check.
    const fixture = await useSchedulerSqlPlugin();
    try {
      const TEAM_ID = `TORIGIN${Date.now()}`;
      const resolveActorIdentity = vi.fn(async () => ({
        identity: {
          id: `identity:${TEAM_ID}:U123`,
          provider: "slack",
          providerSubjectId: "U123",
          providerTenantId: TEAM_ID,
        },
      }));
      const tools = createTools(
        [],
        {},
        {
          conversationId: "slack:C123:1700000000.100000",
          location: {
            id: `location:${TEAM_ID}:C123`,
            provider: "slack",
            teamId: TEAM_ID,
            channelId: "C123",
            threadTs: "1700000000.100000",
          },
          source: { kind: "agent_invocation" },
          destination: {
            platform: "slack",
            teamId: TEAM_ID,
            channelId: "C123",
          },
          actor: { platform: "slack", teamId: TEAM_ID, userId: "U123" },
          egress: {
            async fetch() {
              return new Response("ok");
            },
          },
          resolveActorIdentity,
          workspace: {} as Parameters<typeof getPluginTools>[0]["workspace"],
        },
      );

      await expect(
        executeRegisteredTool(tools.createAutomation!, {
          instruction: "Post a weekly digest.",
          trigger: {
            type: "schedule",
            schedule: {
              kind: "recurring",
              frequency: "weekly",
              time: "09:00",
              weekdays: ["monday"],
              timezone: "America/Los_Angeles",
            },
          },
        }),
      ).rejects.toThrow("Automation tools need a Turn that a person started.");
      await expect(
        executeRegisteredTool(tools.deleteAutomation!, {
          automationId: "sched_missing",
        }),
      ).rejects.toThrow("Automation tools need a Turn that a person started.");
      await expect(
        executeRegisteredTool(tools.createAutomation!, {
          instruction: "Summarize new channel messages.",
          trigger: {
            type: "event",
            namespace: "slack",
            identifier: "C123",
            resourceType: "channel",
            label: "#general",
            events: ["message.posted"],
          },
        }),
      ).rejects.toThrow("Automation tools need a Turn that a person started.");
      expect(resolveActorIdentity).not.toHaveBeenCalled();
      await expect(
        listStoredTasksForTeam(fixture.sql.db(), TEAM_ID),
      ).resolves.toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});

describe("Scheduled automation tool execution modes", () => {
  beforeEach(async () => {
    await initializeSchedulerSqlStore();
  });

  afterEach(async () => {
    await cleanupSchedulerSqlStore();
    vi.restoreAllMocks();
  });

  it("all write tools have executionMode sequential", () => {
    const context = createContext();

    const createTool = createAutomationTool(context, NO_EVENTS);
    const listTool = createSearchAutomationsTool(context, NO_EVENTS);
    const updateTool = createUpdateAutomationTool(context, NO_EVENTS);
    const deleteTool = createDeleteAutomationTool(context, NO_EVENTS);
    const runNowTool = createRunAutomationNowTool(context, NO_EVENTS);

    // Write tools must force sequential execution so a same-turn
    // searchAutomations cannot race ahead of a preceding scheduled-automation
    // create, update, or delete write.
    expect(createTool.executionMode).toBe("sequential");
    expect(updateTool.executionMode).toBe("sequential");
    expect(deleteTool.executionMode).toBe("sequential");
    expect(runNowTool.executionMode).toBe("sequential");

    // List is read-only; it inherits the sequential batch gate from any
    // write tool it shares a turn with (pi-agent-core makes the whole
    // batch sequential when any tool in it is sequential).
    expect(listTool.executionMode).not.toBe("sequential");
  });
});
