import { createAutomationTool } from "@/chat/automations/tools/create";
import { automationToolContext } from "@/chat/automations/tool-access";
import { createSlackSource, type SlackActor } from "@sentry/junior-plugin-api";
import { getDb, getSqlExecutor } from "@/chat/db";
import {
  getEventAutomation,
  saveEventAutomation,
} from "@/chat/event-automations/store";
import type { EventAutomation } from "@/chat/event-automations/types";
import { eventCatalogEntry, type EventCatalog } from "@/chat/events/catalog";
import { upsertIdentity } from "@/chat/identities/sql";
import { readActorIdentity } from "@/chat/plugins/viewer";
import type { ToolRuntimeContext } from "@/chat/tools/types";

export const teamId = `TEVENT${Date.now()}`;
const REVIEW_MATCH_FIELDS = {
  repo: { kind: "string", description: "Repository", case: "lower" },
  pullRequest: { kind: "number", description: "Pull request number" },
} as const;
export const EVENT_CATALOG: EventCatalog = {
  github: eventCatalogEntry({
    resourceTypes: [
      {
        type: "pull_request",
        supportedEvents: [
          "pull_request.review.changes_requested",
          "pull_request.review.commented",
        ],
        matchFields: REVIEW_MATCH_FIELDS,
      },
      {
        type: "review_target",
        supportedEvents: [
          "pull_request.review.changes_requested",
          "pull_request.review.commented",
        ],
        matchFields: REVIEW_MATCH_FIELDS,
      },
    ],
    events: {
      "pull_request.review.changes_requested": { reach: { anyOf: ["repo"] } },
      "pull_request.review.commented": { reach: { anyOf: ["repo"] } },
    },
    normalizeIdentifier: (identifier: string) => identifier.toLowerCase(),
  }),
  sentry: eventCatalogEntry({
    resourceTypes: [
      {
        type: "issue",
        supportedEvents: ["issue.closed"],
        matchFields: {
          issueId: { kind: "string", description: "Sentry issue ID" },
        },
      },
    ],
    events: { "issue.closed": { reach: { anyOf: ["issueId"] } } },
  }),
};

/** Build the source and actor for an Automation tool call. */
export function context(
  userId = "U123",
  channelId = "C123",
  sourceVisibility: "private" | "public" = channelId.startsWith("C")
    ? "public"
    : "private",
  threadTs?: string,
  workspaceTeamId = teamId,
): ToolRuntimeContext {
  const destination = {
    platform: "slack" as const,
    teamId: workspaceTeamId,
    channelId,
  };
  const actor: SlackActor = {
    platform: "slack",
    teamId: workspaceTeamId,
    userId,
  };
  return {
    conversationId: "test:event-annotations",
    actor,
    // Slack turns store the actor identity before tools run.
    resolveActorIdentity: async () => {
      await upsertIdentity(getSqlExecutor(), {
        kind: "user",
        provider: "slack",
        providerTenantId: workspaceTeamId,
        providerSubjectId: userId,
      });
      return await readActorIdentity(actor);
    },
    destination,
    source: createSlackSource({
      teamId: destination.teamId,
      channelId: destination.channelId,
      ...(threadTs ? { threadTs } : undefined),
      visibility: sourceVisibility,
    }),
    userText: "Create a task for review feedback.",
  } as ToolRuntimeContext;
}

/** Execute a tool with parsed input and a retry-stable call identity. */
export async function execute<TInput>(
  tool: {
    execute?: (input: TInput, options: { toolCallId?: string }) => unknown;
    prepareArguments?: (input: unknown) => TInput;
  },
  input: unknown,
  toolCallId = "event-automation-call",
) {
  if (!tool.execute) throw new Error("tool execute function missing");
  const prepared = tool.prepareArguments?.(input) ?? input;
  return await tool.execute(prepared as TInput, {
    toolCallId,
  });
}

/** Build the review event that `createTask` Automations match. */
export function changesRequestedEvent(eventKey: string) {
  return {
    eventKey,
    eventType: "pull_request.review.changes_requested",
    occurredAtMs: Date.now(),
    namespace: "github",
    identifier: "getsentry/junior#1174",
    trustedSummary: "A reviewer requested changes.",
    data: REVIEW_DATA,
  };
}

/** Event data of the pull request that `createTask` Automations match. */
export const REVIEW_DATA = { repo: "getsentry/junior", pullRequest: 1174 };

/**
 * Give an Automation a trigger with an identifier, as a release before
 * filter-only writes saved it.
 */
export async function saveLegacyTrigger(
  id: string,
  trigger: EventAutomation["trigger"],
) {
  const task = await getEventAutomation(getDb(), id);
  return (await saveEventAutomation(getDb(), { ...task!, trigger }))!;
}

/** Create an event Automation through its production tool. */
export async function createTask(
  instruction: string,
  toolCallId?: string,
  events = ["pull_request.review.changes_requested"],
  taskContext = context(),
) {
  return (await execute(
    createAutomationTool(automationToolContext(taskContext), EVENT_CATALOG),
    {
      instruction,
      outcomes: [],
      trigger: {
        type: "event",
        namespace: "github",
        label: "GitHub PR getsentry/junior#1174",
        events,
        match: REVIEW_DATA,
      },
    },
    toolCallId ?? instruction,
  )) as { automation: { id: string } };
}
