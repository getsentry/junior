import {
  automationListQuerySchema,
  type AutomationList,
  type AutomationSummary,
} from "@sentry/junior/api/schema";

function creator(automation: AutomationSummary) {
  return automation.createdByEmail ?? automation.createdBy;
}
function destination(automation: AutomationSummary) {
  return `${automation.destination.teamId}:${automation.destination.channelId}`;
}

/** Apply web collection controls to local preview and browser fixtures. */
export function mockAutomationCollection(
  report: Pick<
    AutomationList,
    "automations" | "executionDays" | "executionHours" | "executionSixHours"
  >,
  params: URLSearchParams = new URLSearchParams(),
): AutomationList {
  const input = automationListQuerySchema.parse(Object.fromEntries(params));
  const all = report.automations;
  const filtered = all
    .filter((automation) => {
      const search =
        `${automation.title} ${automation.instruction} ${automation.kind === "event" ? automation.resource : ""}`.toLowerCase();
      return (
        (input.scope !== "mine" || automation.ownedByViewer) &&
        (input.scope !== "public" ||
          automation.destination.visibility === "public") &&
        (input.type === "all" || automation.kind === input.type) &&
        (input.state === "all" ||
          (automation.kind === "event" ? "active" : automation.status) ===
            input.state) &&
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
            : b.createdAt.localeCompare(a.createdAt);
      return order || b.id.localeCompare(a.id);
    });
  const page = Math.min(
    input.page,
    Math.max(1, Math.ceil(filtered.length / input.pageSize)),
  );
  return {
    ...report,
    automations: filtered.slice(
      (page - 1) * input.pageSize,
      page * input.pageSize,
    ),
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
