import { createHash } from "node:crypto";
import { z } from "zod";
import { getDb } from "@/chat/db";
import {
  createEventAutomation,
  getEventAutomation,
} from "@/chat/event-automations/store";
import {
  eventAutomationMatchesDestination,
  eventAutomationSuccess,
  eventAutomationToolResultSchema,
  registeredEventAutomationTriggerSchema,
  requireEventAutomationSlackContext,
  requireSupportedEventAutomationTrigger,
} from "@/chat/event-automations/tool-support";
import type { EventAutomation } from "@/chat/event-automations/types";
import { completeText } from "@/chat/pi/client";
import {
  normalizeCatalogEventIdentifier,
  type EventCatalog,
} from "@/chat/events/catalog";
import {
  resolveTaskTitle,
  SHORT_TITLE_MAX_LENGTH,
} from "@/chat/services/short-title";
import { zodTool } from "@/chat/tool-support/zod-tool";
import {
  resolveTaskOutcomes,
  taskOutcomeInputSchema,
  type TaskOutcomeInput,
} from "@/chat/task-outcomes";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tools/types";

/** Build a retry-stable task id scoped to actor, destination, and tool call. */
function buildEventAutomationId(args: {
  channelId: string;
  teamId: string;
  toolCallId: string | undefined;
  userId: string;
}): string {
  const toolCallId = args.toolCallId?.trim();
  if (!toolCallId) {
    throw new Error("Event automation creation requires a tool-call identity.");
  }
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        actor: args.userId,
        channel: args.channelId,
        operation: toolCallId,
        team: args.teamId,
      }),
    )
    .digest("hex")
    .slice(0, 32);
  return `evt_${digest}`;
}

/** Create the core tool that stores an event automation. */
export function createEventAutomationTool(
  context: ToolRuntimeContext,
  catalog: EventCatalog,
) {
  const trigger = registeredEventAutomationTriggerSchema(catalog);
  return zodTool({
    approvalMode: "review",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    executionMode: "sequential",
    description:
      "Create a durable event automation that executes the supplied instruction for every matching event. Use for whenever-this-happens-do-X automation; ordinary watch, notify, or tell-me-when requests use watchEvents instead. The task may use the creator's connected credentials. Prefer a subscribable tool result when available.",
    inputSchema: z
      .object({
        task: z.string().trim().min(1).max(4000),
        title: z
          .string()
          .trim()
          .min(1)
          .max(SHORT_TITLE_MAX_LENGTH)
          .nullable()
          .describe(
            "Optional short display title. Omit or use null to generate one from the task instruction.",
          )
          .optional(),
        trigger,
        outcomes: z
          .array(taskOutcomeInputSchema)
          .max(5)
          .describe(
            "Messages to send after successful work. Use an empty list to send nothing. Omit to send one message to the current Slack conversation.",
          )
          .optional(),
        credentialMode: z
          .enum(["creator", "system"])
          .nullable()
          .describe(
            "Use creator to make the task creator's connected credentials available, or system when the creator says not to use them. Omit or use null for the creator default.",
          )
          .optional(),
      })
      .strict(),
    prepareArguments(args) {
      const input = args as {
        task: string;
        title?: string | null;
        trigger: z.input<typeof trigger>;
        outcomes?: TaskOutcomeInput[];
        credentialMode?: "creator" | "system" | null;
      };
      const prepared = { ...input };
      if (prepared.title == null) {
        delete prepared.title;
      }
      if (
        prepared.credentialMode === "creator" ||
        prepared.credentialMode === null
      ) {
        delete prepared.credentialMode;
      }
      return prepared;
    },
    outputSchema: eventAutomationToolResultSchema,
    async execute(input, options) {
      const { actor, destination, source } =
        requireEventAutomationSlackContext(context);
      const match = requireSupportedEventAutomationTrigger(
        catalog,
        input.trigger,
      );
      const id = buildEventAutomationId({
        channelId: destination.channelId,
        teamId: destination.teamId,
        toolCallId: options.toolCallId,
        userId: actor.userId,
      });
      const db = getDb();
      const existing = await getEventAutomation(db, id);
      if (existing) {
        if (
          !eventAutomationMatchesDestination(existing, destination) ||
          existing.createdBy.slackUserId !== actor.userId
        ) {
          throw new ToolInputError(
            "Event automation operation identity is invalid.",
          );
        }
        // Live create retries stay idempotent. Deleted rows fall through and reactivate.
        if (existing.status !== "deleted") {
          return eventAutomationSuccess(existing, catalog);
        }
      }
      const title = await resolveTaskTitle({
        completeText,
        instruction: input.task,
        title: input.title,
      });
      const task: EventAutomation = {
        id,
        destinationVisibility: source.visibility,
        createdAtMs: Date.now(),
        createdBy: {
          slackUserId: actor.userId,
          ...(actor.fullName ? { fullName: actor.fullName } : undefined),
          ...(actor.userName ? { userName: actor.userName } : undefined),
        },
        credentialMode: input.credentialMode ?? "creator",
        destination,
        outcomes: await resolveTaskOutcomes(
          input.outcomes,
          destination,
          actor.userId,
        ),
        task: { text: input.task },
        ...(title ? { title } : undefined),
        trigger: {
          namespace: input.trigger.namespace,
          identifier: normalizeCatalogEventIdentifier(
            catalog,
            input.trigger.namespace,
            input.trigger.identifier,
          ),
          resourceType: input.trigger.resourceType,
          label: input.trigger.label,
          events: [...new Set(input.trigger.events)],
          ...(match ? { match } : undefined),
        },
      };
      return eventAutomationSuccess(
        await createEventAutomation(db, task),
        catalog,
      );
    },
  });
}
