/**
 * Edit reads for mock Automations, so the Automations tab can open its
 * editor without a database. Saves keep the change in this process.
 */
import {
  automationEditSchema,
  type AutomationEdit,
  type AutomationSummary,
} from "@sentry/junior/api/schema";

const edits = new Map<string, AutomationEdit>();

const REVISION = "a".repeat(64);

function scheduleFor(
  summary: Extract<AutomationSummary, { kind: "scheduled" }>,
) {
  const daily = summary.schedule.startsWith("Every day");
  return {
    kind: "recurring" as const,
    description: summary.schedule,
    timezone: summary.timezone,
    recurrence: daily
      ? {
          frequency: "daily" as const,
          interval: 1,
          startDate: "2026-08-03",
          time: { hour: 8, minute: 0 },
        }
      : {
          frequency: "weekly" as const,
          interval: 1,
          startDate: "2026-08-03",
          time: { hour: 9, minute: 0 },
          weekdays: [1],
        },
  };
}

/** Read the editable values of one mock Automation. */
export function readMockAutomationEdit(
  summary: AutomationSummary,
): AutomationEdit {
  const saved = edits.get(summary.id);
  if (saved) return saved;
  const common = {
    id: summary.id,
    revision: REVISION,
    title: summary.title,
    instruction: summary.instruction,
    credentialMode: summary.credentialMode ?? "creator",
    outcomes: summary.outcomes,
    destination: {
      platform: "slack",
      channelId: summary.destination.channelId,
      teamId: summary.destination.teamId,
    },
    createdBy: { slackUserId: "U123" },
    ownedByViewer: summary.ownedByViewer,
  };
  return automationEditSchema.parse(
    summary.kind === "scheduled"
      ? {
          ...common,
          kind: "scheduled",
          status: summary.status === "completed" ? "completed" : "active",
          nextRunAtMs: summary.nextRunAt
            ? Date.parse(summary.nextRunAt)
            : undefined,
          schedule: scheduleFor(summary),
        }
      : {
          ...common,
          kind: "event",
          status: "active",
          trigger: {
            namespace: "github",
            resourceType: "issue",
            identifier: "getsentry/junior#42",
            label: summary.resource ?? "Issue 42",
            events: ["issue.closed"],
            match: {},
          },
        },
  );
}

/** Keep a mock save, with a new revision, like the API. */
export function saveMockAutomationEdit(
  summary: AutomationSummary,
  body: Record<string, unknown>,
): AutomationEdit {
  const next = automationEditSchema.parse({
    ...readMockAutomationEdit(summary),
    ...body,
    revision: "b".repeat(64),
  });
  edits.set(summary.id, next);
  return next;
}

/** One GitHub source, enough for the event trigger fields. */
export const mockAutomationEventCatalog = [
  {
    namespace: "github",
    displayName: "GitHub",
    events: {
      "issue.closed": { reach: { anyOf: ["state"] } },
      "issue.opened": { reach: "all" },
    },
    anyResourceFields: {
      state: {
        kind: "string",
        description: "Issue state",
        enum: ["open", "closed"],
        events: ["issue.closed", "issue.opened"],
      },
    },
    resourceTypes: [
      {
        type: "issue",
        supportedEvents: ["issue.closed", "issue.opened"],
        matchFields: {
          state: {
            kind: "string",
            description: "Issue state",
            enum: ["open", "closed"],
          },
        },
      },
    ],
  },
];
