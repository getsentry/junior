import {
  automationListQuerySchema,
  type AutomationList,
  type AutomationListItem,
  type AutomationSummary,
} from "@sentry/junior/api/schema";

/** A list row, as the server sends it: no totals that read every run. */
function listItem(automation: AutomationSummary): AutomationListItem {
  const {
    costUsd: _costUsd,
    runs: _runs,
    totalCostUsd: _totalCostUsd,
    totalRuns: _totalRuns,
    ...item
  } = automation;
  return item;
}

/** When the last run ended, or else when the Automation was created. */
function activityAt(automation: AutomationSummary): string {
  return automation.lastRunAt ?? automation.createdAt;
}

function creator(automation: AutomationSummary) {
  return automation.createdByEmail ?? automation.createdBy;
}
function destination(automation: AutomationSummary) {
  return `${automation.destination.teamId}:${automation.destination.channelId}`;
}

/** Apply web collection controls to local preview and browser fixtures. */
export function mockAutomationCollection(
  report: { automations: AutomationSummary[] },
  params: URLSearchParams = new URLSearchParams(),
): AutomationList {
  const input = automationListQuerySchema.parse(Object.fromEntries(params));
  const all = report.automations;
  const filtered = all
    .filter((automation) => {
      const { task } = automation;
      const search = [
        automation.title,
        task.kind === "skill" ? task.skill : task.instruction,
        automation.kind === "event" ? automation.resource : "",
      ]
        .join(" ")
        .toLowerCase();
      return (
        (input.scope !== "mine" || automation.ownedByViewer) &&
        (input.owner !== "me" || automation.ownedByViewer) &&
        (!input.skill ||
          (task.kind === "skill" && task.skill === input.skill)) &&
        (input.scope !== "public" ||
          automation.destination.visibility === "public") &&
        (input.scope !== "attention" ||
          (automation.status !== "paused" &&
            automation.status !== "completed" &&
            (automation.status === "blocked" ||
              (automation.kind === "event" &&
                automation.trigger.problems.length > 0) ||
              automation.lastRunStatus === "failed" ||
              automation.lastRunStatus === "blocked"))) &&
        (input.type === "all" || automation.kind === input.type) &&
        (input.state === "all" ||
          (input.state === "unavailable"
            ? automation.kind === "event" &&
              automation.trigger.problems.length > 0
            : automation.status === input.state)) &&
        (!input.creator || creator(automation) === input.creator) &&
        (!input.destination || destination(automation) === input.destination) &&
        (!input.q || search.includes(input.q.toLowerCase()))
      );
    })
    .sort((a, b) => {
      const order =
        input.sort === "title"
          ? a.title.localeCompare(b.title)
          : input.sort === "oldest"
            ? a.createdAt.localeCompare(b.createdAt)
            : input.sort === "activity"
              ? activityAt(b).localeCompare(activityAt(a))
              : b.createdAt.localeCompare(a.createdAt);
      return order || b.id.localeCompare(a.id);
    });
  // The mock cursor is the offset of the next row. The real one is opaque
  // too, so clients only pass it back.
  const cursorStart =
    input.sort === "activity" && input.cursor ? Number(input.cursor) : 0;
  const page =
    input.sort === "activity"
      ? 1
      : Math.min(
          input.page,
          Math.max(1, Math.ceil(filtered.length / input.pageSize)),
        );
  const start =
    input.sort === "activity" ? cursorStart : (page - 1) * input.pageSize;
  const end = start + input.pageSize;
  return {
    automations: filtered.slice(start, end).map(listItem),
    ...(input.sort === "activity" && end < filtered.length
      ? { nextCursor: String(end) }
      : undefined),
    total: filtered.length,
    page,
    pageSize: input.pageSize,
    counts: {
      all: all.length,
      mine: all.filter((automation) => automation.ownedByViewer).length,
      public: all.filter(
        (automation) => automation.destination.visibility === "public",
      ).length,
      private: all.filter(
        (automation) => automation.destination.visibility === "private",
      ).length,
    },
    creators: [
      ...new Map(
        all.map((automation) => [
          creator(automation),
          { value: creator(automation), label: automation.createdBy },
        ]),
      ).values(),
    ],
    destinations: [
      ...new Map(
        all.map((automation) => [
          destination(automation),
          {
            value: destination(automation),
            label: automation.destination.label,
          },
        ]),
      ).values(),
    ],
  };
}
