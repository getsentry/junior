import { createSlackSource, type SlackActor } from "@sentry/junior-plugin-api";
import { getSqlExecutor } from "@/chat/db";
import { eventCatalogEntry, type EventCatalog } from "@/chat/events/catalog";
import { upsertIdentity } from "@/chat/identities/sql";
import { readActorIdentity } from "@/chat/plugins/viewer";
import { createEventAutomationTool } from "@/chat/tools/create-event-automation";
import type { ToolRuntimeContext } from "@/chat/tools/types";

export const teamId = `TEVENT${Date.now()}`;
export const EVENT_CATALOG: EventCatalog = {
  github: eventCatalogEntry({
    resourceTypes: [
      {
        type: "pull_request",
        supportedEvents: [
          "pull_request.review.changes_requested",
          "pull_request.review.commented",
        ],
      },
      {
        type: "review_target",
        supportedEvents: [
          "pull_request.review.changes_requested",
          "pull_request.review.commented",
        ],
      },
    ],
    events: {
      "pull_request.review.changes_requested": { reach: "resource" },
      "pull_request.review.commented": { reach: "resource" },
    },
    normalizeIdentifier: (identifier: string) => identifier.toLowerCase(),
  }),
  sentry: eventCatalogEntry({
    resourceTypes: [{ type: "issue", supportedEvents: ["issue.closed"] }],
    events: { "issue.closed": { reach: "resource" } },
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
  };
}

/** Create an event Automation through its production tool. */
export async function createTask(
  instruction: string,
  toolCallId?: string,
  events = ["pull_request.review.changes_requested"],
  taskContext = context(),
) {
  return (await execute(
    createEventAutomationTool(taskContext, EVENT_CATALOG),
    {
      instruction,
      outcomes: [],
      trigger: {
        namespace: "github",
        identifier: "getsentry/junior#1174",
        resourceType: "pull_request",
        label: "GitHub PR getsentry/junior#1174",
        events,
      },
    },
    toolCallId ?? instruction,
  )) as { automation: { id: string } };
}
