import { z } from "zod";
import type { AutomationSummary } from "@/api/schema/automation";
import { readViewerAutomationSummary } from "@/chat/automations/read";
import {
  getDashboardConversationLink,
  getDashboardTaskLink,
} from "@/chat/dashboard-link";
import { readActorIdentity } from "@/chat/plugins/viewer";
import type { SlackEntity } from "./cards";
import { getSlackClient } from "./client";

type DetailField = NonNullable<
  SlackEntity["entity_payload"]["custom_fields"]
>[number];

function textField(key: string, label: string, value: string): DetailField {
  return { key, label, type: "string", value };
}

function dateField(
  key: string,
  label: string,
  value: string | undefined,
  empty: string,
): DetailField {
  return value
    ? {
        key,
        label,
        type: "slack#/types/timestamp",
        value: Math.floor(Date.parse(value) / 1000),
      }
    : textField(key, label, empty);
}

function renderAutomationDetails(
  automation: AutomationSummary,
): SlackEntity | undefined {
  const url = getDashboardTaskLink(automation.id);
  if (!url) return undefined;

  const status =
    automation.kind === "scheduled"
      ? automation.status
      : automation.triggerAvailable
        ? "ready"
        : "unavailable";
  // Item entities use custom_fields only. Do not add task-specific fields.
  const fields: DetailField[] = [
    textField("status", "Status", status),
    {
      ...textField("description", "Instruction", automation.instruction),
      format: "markdown",
      long: true,
    },
  ];
  if (automation.kind === "scheduled") {
    fields.push(
      { ...textField("trigger", "Schedule", automation.schedule), long: true },
      dateField("next_run", "Next run", automation.nextRunAt, "None"),
    );
  } else {
    fields.push(
      textField("source", "Source", automation.source),
      { ...textField("resource", "Resource", automation.resource), long: true },
      {
        ...textField("events", "Events", automation.events.join(", ")),
        long: true,
      },
    );
    if (!automation.triggerAvailable) {
      fields.push({
        ...textField(
          "warning",
          "Needs attention",
          "Trigger unavailable. This automation cannot receive events.",
        ),
        long: true,
      });
    }
  }
  const lastRun = dateField(
    "last_run",
    "Last execution",
    automation.lastRunAt,
    "Never run",
  );
  if (automation.lastRunAt && automation.lastConversationId) {
    lastRun.link = getDashboardConversationLink(automation.lastConversationId);
  }
  fields.push(
    textField(
      "outcomes",
      "Outcomes",
      automation.outcomes.length === 0
        ? "None (silent)"
        : `${automation.outcomes.length} message${automation.outcomes.length === 1 ? "" : "s"}`,
    ),
    textField(
      "destination",
      "Destination",
      `${automation.destination.label} · ${automation.destination.visibility}`,
    ),
    textField("created_by", "Created by", automation.createdBy),
    dateField("date_created", "Created", automation.createdAt, "Unknown"),
    textField(
      "executions",
      "Executions",
      `${automation.totalRuns} total · ${automation.runs[30]} in the last 30 days`,
    ),
    lastRun,
  );

  return {
    entity_type: "slack#/entities/item",
    external_ref: { id: automation.id, type: "automation" },
    url,
    entity_payload: {
      attributes: {
        title: { text: automation.title },
        display_type:
          automation.kind === "scheduled"
            ? "Scheduled automation"
            : "Event automation",
      },
      custom_fields: fields,
    },
  };
}

const detailsEventSchema = z.object({
  trigger_id: z.string().min(1),
  user: z.string().min(1),
  external_ref: z.object({
    id: z.string().min(1),
    type: z.literal("automation"),
  }),
});

/** Answer a Work Object open or refresh with current, viewer-visible facts. */
export async function presentSlackAutomationDetails(
  event: Record<string, unknown>,
  teamId: string | undefined,
): Promise<void> {
  const parsed = detailsEventSchema.safeParse(event);
  const client = getSlackClient();
  const triggerId = event.trigger_id;
  if (typeof triggerId !== "string" || !triggerId) return;

  if (!parsed.success || !teamId) {
    await client.entity.presentDetails({
      trigger_id: triggerId,
      error: { status: "not_found" },
    });
    return;
  }

  const identity = await readActorIdentity({
    platform: "slack",
    teamId,
    userId: parsed.data.user,
  });
  const automation = identity?.user
    ? await readViewerAutomationSummary(
        identity.user,
        parsed.data.external_ref.id,
      )
    : undefined;
  const entity = automation ? renderAutomationDetails(automation) : undefined;
  if (!entity) {
    // Use one response for inaccessible and deleted objects. Do not leak titles.
    await client.entity.presentDetails({
      trigger_id: triggerId,
      error: { status: "not_found" },
    });
    return;
  }

  await client.entity.presentDetails({
    trigger_id: triggerId,
    metadata: entity,
  });
}
